import { createHash } from "node:crypto";
import { APIError } from "@typesafe-ai/sdk";
import type { Questions, SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";
import { batchPairs, buildState, pairQuestions, questionIds } from "./questions.ts";
import type { BatchOptions } from "./questions.ts";
import type { JudgeStats, Judgment, PairSnippet } from "./types.ts";

export interface JudgeRequest {
  state: Record<string, unknown>;
  questions: Questions;
  model?: string;
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

export interface JudgeOptions extends BatchOptions {
  concurrency?: number;
  model?: string;
  repository?: string;
  cache?: JudgeCache;
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

export async function judgePairs(pairs: PairSnippet[], client: JudgeClient, options: JudgeOptions = {}): Promise<JudgeOutcome> {
  const started = Date.now();
  const state = buildState(options.repository ?? "the repository");
  const judgments = new Map<number, Judgment>();
  const failures = new Map<number, string>();
  const stats: JudgeStats = { judged: 0, unjudged: 0, requests: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, elapsedMs: 0 };
  const report = () => options.onProgress?.({ judged: judgments.size, unjudged: failures.size, total: pairs.length, requests: stats.requests });

  const runBatch = async (batch: PairSnippet[]): Promise<void> => {
    const questions: Questions = Object.assign({}, ...batch.map(pairQuestions));
    const model = options.model ?? client.defaultModel;
    const request: JudgeRequest = { state, questions, ...(model !== undefined ? { model } : {}) };
    const hash = requestHash(request);
    const split = async () => {
      const middle = Math.ceil(batch.length / 2);
      await runBatch(batch.slice(0, middle));
      await runBatch(batch.slice(middle));
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
      try {
        response = await call(client, request);
      } catch (error) {
        stats.requests += 1;
        const message = describeError(error);
        if (isRequestRejected(error)) {
          options.cache?.set(hash, request, { rejected: true, status: error.status, message });
          if (batch.length > 1) return split();
        }
        for (const pair of batch) failures.set(pair.index, message);
        report();
        return;
      }
      stats.requests += 1;
      stats.inputTokens += response.usage.input_tokens;
      stats.outputTokens += response.usage.output_tokens;
      options.cache?.set(hash, request, response);
    }
    for (const pair of batch) {
      try {
        judgments.set(pair.index, toJudgment(pair, response));
      } catch (error) {
        failures.set(pair.index, describeError(error));
      }
    }
    report();
  };

  await mapConcurrent(batchPairs(pairs, options), options.concurrency ?? 4, runBatch);
  stats.judged = judgments.size;
  stats.unjudged = failures.size;
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

export function toJudgment(pair: PairSnippet, response: JudgeResponse): Judgment {
  const ids = questionIds(pair.index);
  const answers = response.answers as Record<string, { type: string; score?: number; confidence?: number; probabilities?: Record<string, number>; noul?: number } | undefined>;
  const refactor = answers[ids.refactor];
  const sameLogic = answers[ids.sameLogic];
  const sameConcept = answers[ids.sameConcept];
  if (refactor?.type !== "score" || typeof refactor.score !== "number") throw new Error(`no score answer for pair ${pair.index}`);
  if (sameLogic?.type !== "noul" || typeof sameLogic.noul !== "number") throw new Error(`no same_logic answer for pair ${pair.index}`);
  if (sameConcept?.type !== "noul" || typeof sameConcept.noul !== "number") throw new Error(`no same_concept answer for pair ${pair.index}`);
  return {
    score: refactor.score,
    confidence: refactor.confidence ?? 0,
    probabilities: refactor.probabilities ?? {},
    sameLogic: sameLogic.noul,
    sameConcept: sameConcept.noul,
    model: response.model,
    ...(response.requestId !== undefined ? { requestId: response.requestId } : {}),
  };
}

function isRequestRejected(error: unknown): error is APIError {
  return error instanceof APIError && (error.status === 400 || error.status === 422 || error.status === 413);
}

function describeError(error: unknown): string {
  if (error instanceof APIError) return `${error.name}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function mapConcurrent<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  });
  await Promise.all(workers);
}
