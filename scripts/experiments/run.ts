import fs from "node:fs";
import path from "node:path";
import { BadRequestError } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { estimateTokens } from "../../src/questions.ts";
import {
  Asker,
  CORPORA,
  appendLine,
  describe,
  flag,
  has,
  items,
  loadCorpora,
  mapConcurrent,
  numberFlag,
  progress,
  resultsRoot,
  shuffled,
  subset,
} from "./lib.ts";
import type { Item } from "./lib.ts";
import { KINDS, buildState, pairQuestions, readAnswers } from "./questions-v2.ts";
import type { Kind, Options, Variant } from "./questions-v2.ts";

const USAGE = `usage: node scripts/experiments/run.ts <experiment> [options]

experiments:
  snapshot   detect pairs in every corpus and store them (no requests)
  ceilings   find the request and state token ceilings (a few dozen requests)
  solo       one request per pair
  batched    many pairs per request
  sweep      the batched set at several concurrencies

options:
  --corpus <a,b|all>      corpora (default all)
  --refresh               snapshot: detect again even when a snapshot exists
  --arm <name>            result file name (default: experiment)
  --variant <v>           long | compact | state (default long)
  --kinds <k,k>           refactor,same_logic,same_concept,shape (default all)
  --repeat <n>            passes (default 1)
  --subset <n>            first n pairs of a seeded shuffle of the corpora
  --seed <n>              shuffle seed (default 1)
  --batch <n>             pairs per request for batched (default 40)
  --budget <tokens>       estimated tokens per request cap for batched (default 40000)
  --shuffle               reshuffle batch membership on every pass
  --concurrency <n|a,b>   requests in flight (default 32; a list for sweep)
  --no-doc                strip the comment block from every declaration
  --no-paths              hide file paths (a.ts / b.ts)
  --keys <file>           only the pair keys in this JSON file (an object keyed by pair key)
  --conventions <text>    a repository_conventions note added to the state
  --model <name>          model override
`;

interface Result {
  exp: string;
  arm: string;
  corpus: string;
  key: string;
  index: number;
  variant: Variant;
  kinds: Kind[];
  repeat: number;
  batch?: string;
  position?: number;
  batchSize?: number;
  concurrency?: number;
  answers: ReturnType<typeof readAnswers>;
  inputTokens: number;
  ms: number;
  requestId?: string | undefined;
  model?: string;
  error?: string;
}

const argv = process.argv.slice(2);
const experiment = argv[0];
if (experiment === undefined || has(argv, "help")) {
  process.stdout.write(USAGE);
  process.exit(experiment === undefined ? 1 : 0);
}

const corpusNames = (flag(argv, "corpus") ?? "all").split(",");
const arm = flag(argv, "arm") ?? experiment;
const variant = (flag(argv, "variant") ?? "long") as Variant;
const kinds = (flag(argv, "kinds") ?? "all") === "all" ? KINDS : ((flag(argv, "kinds") ?? "").split(",") as Kind[]);
const repeat = numberFlag(argv, "repeat", 1);
const seed = numberFlag(argv, "seed", 1);
const size = flag(argv, "subset") !== undefined ? numberFlag(argv, "subset", 0) : undefined;
const batchSize = numberFlag(argv, "batch", 40);
const budget = numberFlag(argv, "budget", 40_000);
const conventions = flag(argv, "conventions");
const options: Options = {
  doc: !has(argv, "no-doc"),
  paths: !has(argv, "no-paths"),
  ...(conventions !== undefined ? { conventions } : {}),
};
const model = flag(argv, "model");
const keysFile = flag(argv, "keys");
const onlyKeys =
  keysFile !== undefined
    ? new Set(Object.keys(JSON.parse(fs.readFileSync(keysFile, "utf8")) as Record<string, unknown>))
    : undefined;

function selected(list: Item[]): Item[] {
  const chosen = onlyKeys !== undefined ? list.filter((item) => onlyKeys.has(item.key)) : list;
  return subset(chosen, size, seed);
}
const outFile = path.join(resultsRoot(), experiment, `${arm}.jsonl`);

for (const kind of kinds) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
}
if (!["long", "compact", "state"].includes(variant)) throw new Error(`unknown variant ${variant}`);

function asker(exp: string, name: string): Asker {
  return new Asker({ exp, arm: name, ...(model !== undefined ? { model } : {}) });
}

function summarize(client: Asker, started: number): void {
  const s = client.stats;
  process.stderr.write(
    `${s.requests} requests (${s.ok} ok, ${s.failed} failed, ${s.retries} retries, ${s.rateLimited} rate-limited, ${s.splits} splits), ${s.inputTokens} input tokens, ${((Date.now() - started) / 1000).toFixed(1)}s wall, ${s.requests > 0 ? Math.round(s.ms / s.requests) : 0} ms mean\n`,
  );
}

async function snapshot(): Promise<void> {
  const corpora = await loadCorpora(corpusNames, has(argv, "refresh"));
  for (const corpus of corpora) {
    const tokens = corpus.snippets.reduce((sum, s) => sum + s.tokens, 0);
    process.stdout.write(`${corpus.name}: ${corpus.snippets.length} pairs, ~${tokens} tokens (v1 estimate)\n`);
  }
}

async function ceilings(): Promise<void> {
  const corpora = await loadCorpora(corpusNames);
  const all = items(corpora);
  const client = asker("ceilings", arm);
  const state = buildState("probe", "long");
  const sample = shuffled(all, seed).slice(0, 400);
  const questionsFor = (count: number): Questions =>
    Object.assign(
      {},
      ...sample.slice(0, count).map((item) => pairQuestions(item.snippet, "long", ["refactor"], options)),
    );
  const probe = async (
    probeState: unknown,
    questions: Questions,
    tag: string,
  ): Promise<{ ok: boolean; tokens: number; estimate: number; error?: string }> => {
    const estimate = estimateTokens({ state: probeState, questions, model: client.model });
    try {
      const result = await client.ask(probeState, questions, tag, { split: false });
      return { ok: true, tokens: result.inputTokens, estimate };
    } catch (error) {
      if (!(error instanceof BadRequestError)) throw error;
      return { ok: false, tokens: 0, estimate, error: describe(error) };
    }
  };
  const fits = (count: number) => probe(state, questionsFor(count), `request-ceiling-${count}`);
  let low = 1;
  let high = 400;
  let lastOk = { count: 0, tokens: 0, estimate: 0 };
  let firstBad = { count: 0, estimate: 0, error: "" };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const r = await fits(mid);
    process.stderr.write(
      `request ceiling probe: ${mid} questions -> ${r.ok ? `ok, ${r.tokens} tokens` : r.error} (estimate ${r.estimate})\n`,
    );
    if (r.ok) {
      lastOk = { count: mid, tokens: r.tokens, estimate: r.estimate };
      low = mid + 1;
    } else {
      firstBad = { count: mid, estimate: r.estimate, error: r.error ?? "" };
      high = mid - 1;
    }
  }
  appendLine(outFile, { exp: "ceilings", probe: "request", lastOk, firstBad });
  const one = pairQuestions(sample[0]!.snippet, "long", ["refactor"], options);
  const filler = (chars: number): Record<string, unknown> => ({
    ...state,
    filler: sample
      .map((item) => item.snippet.a.code)
      .join("\n")
      .slice(0, chars),
  });
  const stateFits = (chars: number) => probe(filler(chars), one, `state-ceiling-${chars}`);
  let lowChars = 1000;
  let highChars = 400_000;
  let lastOkState = { chars: 0, tokens: 0, estimate: 0 };
  let firstBadState = { chars: 0, estimate: 0, error: "" };
  while (highChars - lowChars > 2000) {
    const mid = Math.floor((lowChars + highChars) / 2);
    const r = await stateFits(mid);
    process.stderr.write(
      `state ceiling probe: ${mid} chars -> ${r.ok ? `ok, ${r.tokens} tokens` : r.error} (estimate ${r.estimate})\n`,
    );
    if (r.ok) {
      lastOkState = { chars: mid, tokens: r.tokens, estimate: r.estimate };
      lowChars = mid;
    } else {
      firstBadState = { chars: mid, estimate: r.estimate, error: r.error ?? "" };
      highChars = mid;
    }
  }
  appendLine(outFile, { exp: "ceilings", probe: "state", lastOk: lastOkState, firstBad: firstBadState });
  process.stdout.write(
    JSON.stringify({ request: { lastOk, firstBad }, state: { lastOk: lastOkState, firstBad: firstBadState } }, null, 2),
  );
  process.stdout.write("\n");
}

async function solo(): Promise<void> {
  const corpora = await loadCorpora(corpusNames);
  const chosen = selected(items(corpora));
  const concurrency = numberFlag(argv, "concurrency", 32);
  const client = asker("solo", arm);
  const started = Date.now();
  const jobs = Array.from({ length: repeat }, (_, pass) => chosen.map((item) => ({ item, pass: pass + 1 })));
  const flat = jobs.flat();
  process.stderr.write(
    `solo ${arm}: ${chosen.length} pairs x ${repeat} pass(es) = ${flat.length} requests, kinds ${kinds.join(",")}, variant ${variant}\n`,
  );
  await mapConcurrent(
    flat,
    concurrency,
    async ({ item, pass }) => {
      const state = buildState(item.corpus, variant, [item.snippet], options);
      const questions = pairQuestions(item.snippet, variant, kinds, options);
      const base: Omit<Result, "answers" | "inputTokens" | "ms"> = {
        exp: "solo",
        arm,
        corpus: item.corpus,
        key: item.key,
        index: item.snippet.index,
        variant,
        kinds,
        repeat: pass,
        concurrency,
      };
      try {
        const r = await client.ask(state, questions, `${item.key}@${pass}`, { split: false });
        appendLine(outFile, {
          ...base,
          answers: readAnswers(item.snippet.index, r.answers),
          inputTokens: r.inputTokens,
          ms: r.ms,
          requestId: r.requestId,
          model: r.model,
        } satisfies Result);
      } catch (error) {
        appendLine(outFile, { ...base, answers: {}, inputTokens: 0, ms: 0, error: describe(error) } satisfies Result);
      }
    },
    progress(`solo ${arm}`),
  );
  summarize(client, started);
}

interface Batch {
  corpus: string;
  id: string;
  members: Item[];
}

function planBatches(chosen: Item[], pass: number, reshuffle: boolean): Batch[] {
  const byCorpus = new Map<string, Item[]>();
  for (const item of reshuffle ? shuffled(chosen, seed * 1000 + pass) : chosen) {
    byCorpus.set(item.corpus, [...(byCorpus.get(item.corpus) ?? []), item]);
  }
  const batches: Batch[] = [];
  for (const [corpus, list] of byCorpus) {
    let current: Item[] = [];
    let used = 0;
    const flush = () => {
      if (current.length === 0) return;
      batches.push({ corpus, id: `${corpus}/${pass}/${batches.length}`, members: current });
      current = [];
      used = 0;
    };
    for (const item of list) {
      const tokens =
        estimateTokens(pairQuestions(item.snippet, variant, kinds, options)) +
        (variant === "state" ? estimateTokens(buildState(corpus, "state", [item.snippet], options)) : 0);
      if (current.length > 0 && (current.length >= batchSize || used + tokens > budget)) flush();
      current.push(item);
      used += tokens;
    }
    flush();
  }
  return batches;
}

async function runBatches(
  client: Asker,
  batches: Batch[],
  concurrency: number,
  pass: number,
  label: string,
): Promise<void> {
  await mapConcurrent(
    batches,
    concurrency,
    async (batch) => {
      const snippets = batch.members.map((item) => item.snippet);
      const state = buildState(batch.corpus, variant, snippets, options);
      const questions: Questions = Object.assign(
        {},
        ...snippets.map((snippet) => pairQuestions(snippet, variant, kinds, options)),
      );
      const common = {
        exp: experiment!,
        arm,
        variant,
        kinds,
        repeat: pass,
        batch: batch.id,
        batchSize: batch.members.length,
        concurrency,
      };
      try {
        const r = await client.ask(state, questions, batch.id);
        batch.members.forEach((item, position) => {
          appendLine(outFile, {
            ...common,
            corpus: item.corpus,
            key: item.key,
            index: item.snippet.index,
            position,
            answers: readAnswers(item.snippet.index, r.answers),
            inputTokens: r.inputTokens,
            ms: r.ms,
            requestId: r.requestId,
            model: r.model,
          } satisfies Result);
        });
      } catch (error) {
        const message = describe(error);
        batch.members.forEach((item, position) => {
          appendLine(outFile, {
            ...common,
            corpus: item.corpus,
            key: item.key,
            index: item.snippet.index,
            position,
            answers: {},
            inputTokens: 0,
            ms: 0,
            error: message,
          } satisfies Result);
        });
      }
    },
    progress(label),
  );
}

async function batched(): Promise<void> {
  const corpora = await loadCorpora(corpusNames);
  const chosen = selected(items(corpora));
  const concurrency = numberFlag(argv, "concurrency", 32);
  const client = asker("batched", arm);
  const started = Date.now();
  for (let pass = 1; pass <= repeat; pass += 1) {
    const batches = planBatches(chosen, pass, has(argv, "shuffle"));
    process.stderr.write(
      `batched ${arm} pass ${pass}/${repeat}: ${chosen.length} pairs in ${batches.length} requests (batch ${batchSize}, budget ${budget}, variant ${variant}, kinds ${kinds.join(",")})\n`,
    );
    await runBatches(client, batches, concurrency, pass, `batched ${arm} pass ${pass}`);
  }
  summarize(client, started);
}

async function sweep(): Promise<void> {
  const corpora = await loadCorpora(corpusNames);
  const chosen = selected(items(corpora));
  const levels = (flag(argv, "concurrency") ?? "4,8,16,32,64,128").split(",").map(Number);
  for (const [i, concurrency] of levels.entries()) {
    const client = asker("sweep", `${arm}-c${concurrency}`);
    const batches = planBatches(chosen, i + 1, false);
    const started = Date.now();
    await runBatches(client, batches, concurrency, i + 1, `sweep c=${concurrency}`);
    const wall = Date.now() - started;
    const s = client.stats;
    appendLine(path.join(resultsRoot(), "sweep", `${arm}-summary.jsonl`), {
      concurrency,
      requests: s.requests,
      ok: s.ok,
      failed: s.failed,
      retries: s.retries,
      rateLimited: s.rateLimited,
      inputTokens: s.inputTokens,
      wallMs: wall,
      meanMs: Math.round(s.ms / Math.max(1, s.requests)),
      requestsPerSecond: s.requests / (wall / 1000),
      tokensPerSecond: s.inputTokens / (wall / 1000),
    });
    summarize(client, started);
  }
}

const experiments: Record<string, () => Promise<void>> = { snapshot, ceilings, solo, batched, sweep };
const chosenExperiment = experiments[experiment];
if (chosenExperiment === undefined) {
  process.stderr.write(`unknown experiment ${experiment}\n${USAGE}`);
  process.exit(1);
}
process.stderr.write(
  `corpora root ${process.env.CORPORA_DIR ?? "(default)"}; known corpora: ${Object.keys(CORPORA).join(", ")}\n`,
);
await chosenExperiment();
