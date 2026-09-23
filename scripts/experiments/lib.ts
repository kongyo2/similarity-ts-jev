import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APIError, BadRequestError, RateLimitError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { detect, orderPairs, readSnippets } from "../../src/index.ts";
import type { PairSnippet } from "../../src/types.ts";

export interface CorpusSpec {
  name: string;
  dir: string;
  paths: string[];
  exclude: string[];
}

export const CORPORA: Record<string, CorpusSpec> = {
  "date-fns": {
    name: "date-fns",
    dir: "date-fns",
    paths: ["pkgs/core/src"],
    exclude: ["**/*.test.ts", "**/locale/**", "**/*.d.ts"],
  },
  "es-toolkit": {
    name: "es-toolkit",
    dir: "es-toolkit",
    paths: ["src"],
    exclude: ["**/*.spec.ts", "**/*.test.ts", "**/*.d.ts"],
  },
  remeda: {
    name: "remeda",
    dir: "remeda",
    paths: ["packages/remeda/src"],
    exclude: ["**/*.test.ts", "**/*.test-d.ts", "**/*.d.ts"],
  },
  zod: { name: "zod", dir: "zod", paths: ["packages/zod/src"], exclude: ["**/*.test.ts", "**/tests/**", "**/*.d.ts"] },
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function corporaRoot(): string {
  return process.env.CORPORA_DIR ?? path.resolve(HERE, "..", "..", ".corpora");
}

export function resultsRoot(): string {
  return process.env.RESULTS_DIR ?? path.resolve(HERE, "..", "..", ".results");
}

export interface Corpus {
  name: string;
  snippets: PairSnippet[];
}

export async function loadCorpus(spec: CorpusSpec, refresh = false): Promise<Corpus> {
  const snapshotDir = path.join(resultsRoot(), "snapshots");
  const file = path.join(snapshotDir, `${spec.name}.json`);
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Corpus;
  const cwd = path.join(corporaRoot(), spec.dir);
  const detection = await detect({
    similarityTs: { paths: spec.paths, cwd, modes: ["functions", "types", "classes"], exclude: spec.exclude },
  });
  const { snippets } = await readSnippets(orderPairs(detection.pairs), { cwd });
  const corpus: Corpus = { name: spec.name, snippets };
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(corpus));
  return corpus;
}

export async function loadCorpora(names: string[], refresh = false): Promise<Corpus[]> {
  const wanted = names.length === 1 && names[0] === "all" ? Object.keys(CORPORA) : names;
  const out: Corpus[] = [];
  for (const name of wanted) {
    const spec = CORPORA[name];
    if (spec === undefined) throw new Error(`unknown corpus ${name} (known: ${Object.keys(CORPORA).join(", ")})`);
    out.push(await loadCorpus(spec, refresh));
  }
  return out;
}

export interface Item {
  corpus: string;
  key: string;
  snippet: PairSnippet;
}

export function items(corpora: Corpus[]): Item[] {
  return corpora.flatMap((corpus) =>
    corpus.snippets.map((snippet) => ({ corpus: corpus.name, key: `${corpus.name}#${snippet.index}`, snippet })),
  );
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(list: T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function subset<T>(list: T[], size: number | undefined, seed: number): T[] {
  if (size === undefined || size >= list.length) return list;
  return shuffled(list, seed).slice(0, size);
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const CHARS_PER_TOKEN_TEXT = 3.4;
const CHARS_PER_TOKEN_STRUCT = 2.2;
const TEXT_LIKE_LENGTH = 64;

export function estimateTokens(value: unknown): number {
  return Math.ceil(cost(value));
}

function cost(value: unknown): number {
  if (typeof value === "string") {
    const length = JSON.stringify(value).length;
    return length / (value.length >= TEXT_LIKE_LENGTH ? CHARS_PER_TOKEN_TEXT : CHARS_PER_TOKEN_STRUCT);
  }
  if (value === null || typeof value !== "object") return String(value).length / CHARS_PER_TOKEN_STRUCT;
  if (Array.isArray(value))
    return (
      (2 + Math.max(0, value.length - 1)) / CHARS_PER_TOKEN_STRUCT +
      value.reduce((sum: number, item) => sum + cost(item), 0)
    );
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  let total = (2 + Math.max(0, entries.length - 1)) / CHARS_PER_TOKEN_STRUCT;
  for (const [key, v] of entries) total += (JSON.stringify(key).length + 1) / CHARS_PER_TOKEN_STRUCT + cost(v);
  return total;
}

export function appendLine(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export interface AskResult {
  answers: SystemOneResult<Questions>["answers"];
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  requestId: string | undefined;
  splits: number;
}

export interface RequestRecord {
  at: string;
  exp: string;
  arm: string;
  tag: string;
  questions: number;
  bytes: number;
  estimate: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  ok: boolean;
  status: number;
  requestId?: string | undefined;
  model?: string;
  error?: string;
}

export interface AskerOptions {
  exp: string;
  arm: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  logFile?: string;
}

export class Asker {
  readonly #client: TypeSafeClient;
  readonly #exp: string;
  readonly #arm: string;
  readonly #model: string | undefined;
  readonly #log: string;
  readonly stats = {
    requests: 0,
    ok: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    ms: 0,
    retries: 0,
    rateLimited: 0,
    splits: 0,
  };

  constructor(options: AskerOptions) {
    this.#exp = options.exp;
    this.#arm = options.arm;
    this.#model = options.model;
    this.#log = options.logFile ?? path.join(resultsRoot(), "requests.jsonl");
    const stats = this.stats;
    this.#client = new TypeSafeClient({
      timeout: options.timeout ?? 120_000,
      retry: { maxRetries: options.maxRetries ?? 4, backoffInitialMs: 500, backoffMaxMs: 8000 },
      logLevel: "info",
      logger: {
        debug() {},
        info(message: string) {
          if (message.includes("retrying")) stats.retries += 1;
          if (/after 429/.test(message)) stats.rateLimited += 1;
        },
        warn() {},
        error() {},
      },
    });
  }

  get model(): string {
    return this.#model ?? this.#client.defaultModel;
  }

  async ask(state: unknown, questions: Questions, tag: string, options: { split?: boolean } = {}): Promise<AskResult> {
    const body = { state, questions, ...(this.#model !== undefined ? { model: this.#model } : {}) };
    const bytes = JSON.stringify(body).length;
    const estimate = estimateTokens({ ...body, model: this.model });
    const started = Date.now();
    const base = {
      at: new Date(started).toISOString(),
      exp: this.#exp,
      arm: this.#arm,
      tag,
      questions: Object.keys(questions).length,
      bytes,
      estimate,
    };
    try {
      const { data, requestId } = await this.#client
        .systemOne({ state: state as never, questions, ...(this.#model !== undefined ? { model: this.#model } : {}) })
        .withResponse();
      const ms = Date.now() - started;
      this.stats.requests += 1;
      this.stats.ok += 1;
      this.stats.inputTokens += data.usage.input_tokens;
      this.stats.outputTokens += data.usage.output_tokens;
      this.stats.ms += ms;
      appendLine(this.#log, {
        ...base,
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        ms,
        ok: true,
        status: 200,
        requestId,
        model: data.model,
      } satisfies RequestRecord);
      return {
        answers: data.answers,
        model: data.model,
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        ms,
        requestId,
        splits: 0,
      };
    } catch (error) {
      const ms = Date.now() - started;
      this.stats.requests += 1;
      this.stats.failed += 1;
      this.stats.ms += ms;
      const status = error instanceof APIError ? error.status : 0;
      if (error instanceof RateLimitError) this.stats.rateLimited += 1;
      const message = describe(error);
      appendLine(this.#log, {
        ...base,
        inputTokens: 0,
        outputTokens: 0,
        ms,
        ok: false,
        status,
        error: message,
        ...(error instanceof APIError && error.requestId !== undefined ? { requestId: error.requestId } : {}),
      } satisfies RequestRecord);
      const tooBig = error instanceof BadRequestError;
      const ids = Object.keys(questions);
      if (tooBig && options.split !== false && ids.length > 1) {
        this.stats.splits += 1;
        const middle = Math.ceil(ids.length / 2);
        const halves = [ids.slice(0, middle), ids.slice(middle)].map((part) =>
          Object.fromEntries(part.map((id) => [id, questions[id]!])),
        );
        const results = await Promise.all(
          halves.map((half, i) => this.ask(pruneState(state, Object.keys(half)), half, `${tag}/${i}`, options)),
        );
        return {
          answers: Object.assign({}, ...results.map((r) => r.answers)),
          model: results[0]!.model,
          inputTokens: results.reduce((sum, r) => sum + r.inputTokens, 0),
          outputTokens: results.reduce((sum, r) => sum + r.outputTokens, 0),
          ms: Date.now() - started,
          requestId: results[0]!.requestId,
          splits: 1 + results.reduce((sum, r) => sum + r.splits, 0),
        };
      }
      throw error;
    }
  }
}

export function pruneState(state: unknown, questionIds: string[]): unknown {
  if (typeof state !== "object" || state === null) return state;
  const pairs = (state as { pairs?: unknown }).pairs;
  if (typeof pairs !== "object" || pairs === null || Array.isArray(pairs)) return state;
  const wanted = new Set(questionIds.map((id) => id.replace(/_[a-z_]+$/, "")));
  return {
    ...(state as Record<string, unknown>),
    pairs: Object.fromEntries(Object.entries(pairs as Record<string, unknown>).filter(([ref]) => wanted.has(ref))),
  };
}

export function describe(error: unknown): string {
  if (error instanceof APIError)
    return `${error.name} ${error.status}: ${JSON.stringify(error.body ?? "").slice(0, 200)}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function mapConcurrent<T, R>(
  list: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
  onDone?: (done: number, total: number) => void,
): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      out[i] = await run(list[i]!, i);
      done += 1;
      onDone?.(done, list.length);
    }
  });
  await Promise.all(workers);
  return out;
}

export function progress(label: string): (done: number, total: number) => void {
  let last = 0;
  const started = Date.now();
  return (done, total) => {
    const now = Date.now();
    if (done !== total && now - last < 2000) return;
    last = now;
    const rate = done / Math.max(1, (now - started) / 1000);
    process.stderr.write(`\r${label}: ${done}/${total} (${rate.toFixed(1)}/s)${done === total ? "\n" : "   "}`);
  };
}

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return argv[i + 1];
}

export function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function numberFlag(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}
