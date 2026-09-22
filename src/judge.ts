import { createHash } from "node:crypto";
import { APIConnectionError, APIError, BadRequestError, InternalServerError, RateLimitError, UnprocessableEntityError } from "@typesafe-ai/sdk";
import type { Questions, SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";
import { SHAPES, batchPairs, buildState, pairQuestions, questionIds } from "./questions.ts";
import type { BatchOptions, StateOptions } from "./questions.ts";
import type { JudgeStats, Judgment, PairSnippet, Shape } from "./types.ts";

export interface JudgeRequest {
  state: Record<string, unknown>;
  questions: Questions;
  model?: string;
  pass?: number;
}

export interface JudgeResponse {
  model: string;
  answers: SystemOneResult<Questions>["answers"];
  usage: { input_tokens: number; output_tokens: number };
  requestId?: string;
}

export type JudgeClient = Pick<TypeSafeClient, "systemOne"> & { defaultModel?: string };

export interface JudgeRejection {
  rejected: true;
  status: number;
  message: string;
}

export interface JudgeCache {
  get(hash: string): JudgeResponse | JudgeRejection | undefined;
  set(hash: string, request: JudgeRequest, response: JudgeResponse | JudgeRejection): void;
}

export function isRejection(value: JudgeResponse | JudgeRejection): value is JudgeRejection {
  return (value as JudgeRejection).rejected === true;
}

export const DEFAULT_CONCURRENCY = 32;
export const DEFAULT_RETRIES = 2;
export const USD_PER_MILLION_INPUT_TOKENS = 0.042;

export interface JudgeOptions extends BatchOptions, StateOptions {
  concurrency?: number;
  retries?: number;
  model?: string;
  repository?: string;
  cache?: JudgeCache;
  repeat?: number;
  onProgress?: (progress: { judged: number; unjudged: number; total: number; requests: number }) => void;
}

export interface JudgeOutcome {
  judgments: Map<number, Judgment>;
  failures: Map<number, string>;
  stats: JudgeStats;
}

export function requestHash(request: JudgeRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export class AdaptiveLimiter {
  readonly max: number;
  limit: number;
  #inFlight = 0;
  readonly #waiting: (() => void)[] = [];
  #cooldownUntil = 0;

  constructor(max: number) {
    this.max = Math.max(1, max);
    this.limit = this.max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#inFlight -= 1;
      this.#wake();
    }
  }

  throttle(): void {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.#cooldownUntil = Date.now() + 1000;
  }

  recover(): void {
    if (this.limit < this.max) this.limit += 1;
    this.#wake();
  }

  async #acquire(): Promise<void> {
    for (;;) {
      const wait = this.#cooldownUntil - Date.now();
      if (wait > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
        continue;
      }
      if (this.#inFlight < this.limit) {
        this.#inFlight += 1;
        return;
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
  }

  #wake(): void {
    while (this.#waiting.length > 0 && this.#inFlight < this.limit) {
      const next = this.#waiting.shift();
      next?.();
    }
  }
}

interface Sample {
  pass: number;
  judgment: Judgment;
}

export async function judgePairs(pairs: PairSnippet[], client: JudgeClient, options: JudgeOptions = {}): Promise<JudgeOutcome> {
  const started = Date.now();
  const passes = Math.max(1, Math.floor(options.repeat ?? 1));
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const state = buildState(options.repository ?? "the repository", options);
  const samples = new Map<number, Sample[]>();
  const failures = new Map<number, string>();
  const stats: JudgeStats = { judged: 0, unjudged: 0, requests: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, retries: 0, rateLimited: 0, splits: 0, passes, usd: 0, elapsedMs: 0 };
  const limiter = new AdaptiveLimiter(options.concurrency ?? DEFAULT_CONCURRENCY);
  const batches = batchPairs(pairs, options);
  const report = () => {
    const judged = [...samples.values()].filter((list) => list.length > 0).length;
    options.onProgress?.({ judged, unjudged: failures.size, total: pairs.length, requests: stats.requests });
  };

  const record = (pair: PairSnippet, pass: number, judgment: Judgment) => {
    samples.set(pair.index, [...(samples.get(pair.index) ?? []), { pass, judgment }]);
  };

  const runBatch = async (batch: PairSnippet[], pass: number): Promise<void> => {
    const questions: Questions = Object.assign({}, ...batch.map(pairQuestions));
    const model = options.model ?? client.defaultModel;
    const request: JudgeRequest = { state, questions, ...(model !== undefined ? { model } : {}), ...(pass > 1 ? { pass } : {}) };
    const hash = requestHash(request);
    const split = async () => {
      stats.splits += 1;
      const middle = Math.ceil(batch.length / 2);
      await runBatch(batch.slice(0, middle), pass);
      await runBatch(batch.slice(middle), pass);
    };
    const cached = options.cache?.get(hash);
    let response: JudgeResponse;
    if (cached !== undefined && isRejection(cached)) {
      stats.cacheHits += 1;
      if (batch.length > 1) return split();
      for (const pair of batch) failures.set(pair.index, cached.message);
      report();
      return;
    } else if (cached !== undefined) {
      stats.cacheHits += 1;
      response = cached;
    } else {
      let attempt = 0;
      for (;;) {
        try {
          response = await limiter.run(() => call(client, request));
          limiter.recover();
          break;
        } catch (error) {
          stats.requests += 1;
          const message = describeError(error);
          if (error instanceof RateLimitError) {
            stats.rateLimited += 1;
            limiter.throttle();
          }
          if (isRequestRejected(error)) {
            options.cache?.set(hash, request, { rejected: true, status: error.status, message });
            if (batch.length > 1) return split();
            for (const pair of batch) failures.set(pair.index, message);
            report();
            return;
          }
          if (isTransient(error) && attempt < retries) {
            attempt += 1;
            stats.retries += 1;
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random())));
            continue;
          }
          for (const pair of batch) failures.set(pair.index, message);
          report();
          return;
        }
      }
      stats.requests += 1;
      stats.inputTokens += response.usage.input_tokens;
      stats.outputTokens += response.usage.output_tokens;
      options.cache?.set(hash, request, response);
    }
    for (const pair of batch) {
      try {
        record(pair, pass, toJudgment(pair, response));
      } catch (error) {
        failures.set(pair.index, describeError(error));
      }
    }
    report();
  };

  const jobs = Array.from({ length: passes }, (_, i) => batches.map((batch) => ({ batch, pass: i + 1 }))).flat();
  await Promise.all(jobs.map((job) => runBatch(job.batch, job.pass)));

  const judgments = new Map<number, Judgment>();
  for (const pair of pairs) {
    const list = samples.get(pair.index) ?? [];
    if (list.length === 0) continue;
    if (list.length < passes) {
      if (!failures.has(pair.index)) failures.set(pair.index, `only ${list.length} of ${passes} passes answered`);
      continue;
    }
    failures.delete(pair.index);
    judgments.set(pair.index, passes > 1 ? mergePasses(list.sort((x, y) => x.pass - y.pass).map((sample) => sample.judgment)) : list[0]!.judgment);
  }
  stats.judged = judgments.size;
  stats.unjudged = failures.size;
  stats.usd = (stats.inputTokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS;
  stats.elapsedMs = Date.now() - started;
  return { judgments, failures, stats };
}

async function call(client: JudgeClient, request: JudgeRequest): Promise<JudgeResponse> {
  const { data, requestId } = await client
    .systemOne({ state: request.state as never, questions: request.questions, ...(request.model !== undefined ? { model: request.model } : {}) })
    .withResponse();
  return {
    model: data.model,
    answers: data.answers,
    usage: { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens },
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

type RawAnswer = { type: string; score?: number; confidence?: number; probabilities?: Record<string, number>; noul?: number; choice?: string } | undefined;

export function toJudgment(pair: PairSnippet, response: JudgeResponse): Judgment {
  const ids = questionIds(pair.index);
  const answers = response.answers as Record<string, RawAnswer>;
  const refactor = answers[ids.refactor];
  const sameLogic = answers[ids.sameLogic];
  const sameConcept = answers[ids.sameConcept];
  const shape = answers[ids.shape];
  if (refactor?.type !== "score" || typeof refactor.score !== "number") throw new Error(`no score answer for pair ${pair.index}`);
  if (sameLogic?.type !== "noul" || typeof sameLogic.noul !== "number") throw new Error(`no same_logic answer for pair ${pair.index}`);
  if (sameConcept?.type !== "noul" || typeof sameConcept.noul !== "number") throw new Error(`no same_concept answer for pair ${pair.index}`);
  if (shape?.type !== "choice" || typeof shape.choice !== "string" || !SHAPES.includes(shape.choice as Shape)) throw new Error(`no shape answer for pair ${pair.index}`);
  return {
    score: refactor.score,
    confidence: refactor.confidence ?? 0,
    probabilities: refactor.probabilities ?? {},
    sameLogic: sameLogic.noul,
    sameConcept: sameConcept.noul,
    shape: shape.choice as Shape,
    shapeConfidence: shape.confidence ?? 0,
    shapeProbabilities: shape.probabilities ?? {},
    model: response.model,
    ...(response.requestId !== undefined ? { requestId: response.requestId } : {}),
  };
}

export function mergePasses(list: Judgment[]): Judgment {
  const first = list[0];
  if (first === undefined) throw new Error("no passes to merge");
  if (list.length === 1) return { ...first, passes: { count: 1, scores: [first.score], spread: 0 } };
  const mean = (values: number[]) => Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10_000) / 10_000;
  const scores = list.map((judgment) => judgment.score);
  const keys = [...new Set(list.flatMap((judgment) => Object.keys(judgment.probabilities)))];
  const votes = new Map<Shape, number>();
  for (const judgment of list) votes.set(judgment.shape, (votes.get(judgment.shape) ?? 0) + 1);
  const shape = [...votes.entries()].sort((x, y) => y[1] - x[1] || (x[0] === first.shape ? -1 : y[0] === first.shape ? 1 : 0))[0]![0];
  return {
    score: mean(scores),
    confidence: mean(list.map((judgment) => judgment.confidence)),
    probabilities: Object.fromEntries(keys.map((key) => [key, mean(list.map((judgment) => judgment.probabilities[key] ?? 0))])),
    sameLogic: mean(list.map((judgment) => judgment.sameLogic)),
    sameConcept: mean(list.map((judgment) => judgment.sameConcept)),
    shape,
    shapeConfidence: mean(list.map((judgment) => judgment.shapeConfidence)),
    shapeProbabilities: Object.fromEntries(SHAPES.map((option) => [option, mean(list.map((judgment) => judgment.shapeProbabilities[option] ?? 0))])),
    model: first.model,
    ...(first.requestId !== undefined ? { requestId: first.requestId } : {}),
    passes: { count: list.length, scores, spread: Math.round((Math.max(...scores) - Math.min(...scores)) * 1000) / 1000 },
  };
}

function isRequestRejected(error: unknown): error is APIError {
  return error instanceof BadRequestError || error instanceof UnprocessableEntityError || (error instanceof APIError && error.status === 413);
}

function isTransient(error: unknown): boolean {
  return error instanceof RateLimitError || error instanceof InternalServerError || error instanceof APIConnectionError || (error instanceof APIError && error.status === 408);
}

function describeError(error: unknown): string {
  if (error instanceof APIError) return `${error.name}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
