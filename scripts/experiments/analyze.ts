import fs from "node:fs";
import path from "node:path";
import { auc } from "../../src/calibrate.ts";
import { flag, readLines, resultsRoot } from "./lib.ts";
import type { Label, RequestRecord } from "./lib.ts";
import type { Read } from "./questions-v2.ts";

interface Result {
  exp: string;
  arm: string;
  corpus: string;
  key: string;
  index: number;
  variant: string;
  kinds: string[];
  repeat: number;
  batch?: string;
  position?: number;
  batchSize?: number;
  answers: Read;
  inputTokens: number;
  ms: number;
  error?: string;
}

const argv = process.argv.slice(2);
const root = resultsRoot();
const labelsFile = flag(argv, "labels");
const outFile = flag(argv, "out") ?? path.join(root, "summary.json");
const summary: Record<string, unknown> = {};
const lines: string[] = [];

function say(line = ""): void {
  lines.push(line);
}

function table(headers: string[], rows: (string | number)[][]): void {
  say(`| ${headers.join(" | ")} |`);
  say(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) say(`| ${row.map((cell) => (typeof cell === "number" ? fmt(cell) : cell)).join(" | ")} |`);
  say();
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(3);
}

function loadArm(exp: string, arm: string): Result[] {
  return readLines<Result>(path.join(root, exp, `${arm}.jsonl`)).filter((r) => r.error === undefined);
}

const withRefactor = (results: Result[]): Result[] => results.filter((r) => r.answers.refactor !== undefined);

function byKey(results: Result[]): Map<string, Result[]> {
  const out = new Map<string, Result[]>();
  for (const r of results) out.set(r.key, [...(out.get(r.key) ?? []), r]);
  return out;
}

function firstPass(results: Result[]): Map<string, Result> {
  const out = new Map<string, Result>();
  for (const r of results) if (!out.has(r.key)) out.set(r.key, r);
  return out;
}

function pass(results: Result[], n: number): Map<string, Result> {
  const out = new Map<string, Result>();
  for (const r of results) if (r.repeat === n) out.set(r.key, r);
  return out;
}

const mean = (xs: number[]): number => (xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const sd = (xs: number[]): number => {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const level = (score: number): number => Math.max(0, Math.min(3, Math.round(score)));

const CUTOFFS = [1.5, 1.9, 2, 2.1, 2.5];

interface Agreement {
  n: number;
  mad: number;
  bias: number;
  within025: number;
  levelAgree: number;
  flips: Record<string, number>;
  logicMad: number;
  conceptMad: number;
  shapeAgree: number;
  spearman: number;
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]): number[] => {
    const order = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const ranks = new Array<number>(xs.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j += 1;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[order[k]![1]] = r;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function agreement(a: Map<string, Result>, b: Map<string, Result>): Agreement {
  const diffs: number[] = [];
  const signed: number[] = [];
  const logic: number[] = [];
  const concept: number[] = [];
  const sa: number[] = [];
  const sb: number[] = [];
  let levels = 0;
  let shapes = 0;
  let shapeBoth = 0;
  const flips: Record<string, number> = {};
  for (const c of CUTOFFS) flips[String(c)] = 0;
  for (const [key, x] of a) {
    const y = b.get(key);
    if (y === undefined || x.answers.refactor === undefined || y.answers.refactor === undefined) continue;
    const s1 = x.answers.refactor.score;
    const s2 = y.answers.refactor.score;
    diffs.push(Math.abs(s1 - s2));
    signed.push(s2 - s1);
    sa.push(s1);
    sb.push(s2);
    if (level(s1) === level(s2)) levels += 1;
    for (const c of CUTOFFS) if (s1 >= c !== s2 >= c) flips[String(c)]! += 1;
    if (x.answers.same_logic !== undefined && y.answers.same_logic !== undefined)
      logic.push(Math.abs(x.answers.same_logic - y.answers.same_logic));
    if (x.answers.same_concept !== undefined && y.answers.same_concept !== undefined)
      concept.push(Math.abs(x.answers.same_concept - y.answers.same_concept));
    if (x.answers.shape !== undefined && y.answers.shape !== undefined) {
      shapeBoth += 1;
      if (x.answers.shape.choice === y.answers.shape.choice) shapes += 1;
    }
  }
  const n = diffs.length;
  return {
    n,
    mad: mean(diffs),
    bias: mean(signed),
    within025: diffs.filter((d) => d <= 0.25).length / n,
    levelAgree: levels / n,
    flips: Object.fromEntries(Object.entries(flips).map(([c, k]) => [c, k / n])),
    logicMad: mean(logic),
    conceptMad: mean(concept),
    shapeAgree: shapeBoth > 0 ? shapes / shapeBoth : Number.NaN,
    spearman: n > 2 ? spearman(sa, sb) : Number.NaN,
  };
}

function agreementRow(name: string, g: Agreement): (string | number)[] {
  return [
    name,
    g.n,
    g.mad,
    g.bias,
    g.within025,
    g.levelAgree,
    g.flips["1.9"] ?? 0,
    g.logicMad,
    g.conceptMad,
    g.shapeAgree,
    g.spearman,
  ];
}

const AGREEMENT_HEADERS = [
  "arms",
  "pairs",
  "MAD score",
  "bias",
  "within 0.25",
  "level agree",
  "flips @1.9",
  "MAD logic",
  "MAD concept",
  "shape agree",
  "spearman",
];

function tokensPerPair(results: Result[]): {
  tokensPerPair: number;
  msPerRequest: number;
  pairsPerRequest: number;
  requests: number;
} {
  const requests = new Map<string, Result>();
  for (const r of results) {
    const id = `${r.repeat}/${r.batch ?? r.key}`;
    if (!requests.has(id)) requests.set(id, r);
  }
  const list = [...requests.values()];
  const pairs = list.reduce((a, r) => a + (r.batchSize ?? 1), 0);
  return {
    tokensPerPair: list.reduce((a, r) => a + r.inputTokens, 0) / pairs,
    msPerRequest: mean(list.map((r) => r.ms)),
    pairsPerRequest: pairs / list.length,
    requests: list.length,
  };
}

function stability(results: Result[], label: string): Record<string, unknown> {
  const scored = withRefactor(results);
  const groups = byKey(scored);
  const expectedPasses = new Set(scored.map((r) => r.repeat)).size;
  const spreads: number[] = [];
  const sds: number[] = [];
  const flips: Record<string, number> = {};
  const near: Record<string, { flipped: number; total: number }> = {};
  let n = 0;
  let rows = 0;
  let incomplete = 0;
  const logicSpreads: number[] = [];
  const conceptSpreads: number[] = [];
  const shapeChanges: number[] = [];
  for (const list of groups.values()) {
    if (list.length < expectedPasses) incomplete += 1;
    if (list.length < 2) continue;
    n += 1;
    rows += list.length;
    const scores = list.map((r) => r.answers.refactor!.score);
    spreads.push(Math.max(...scores) - Math.min(...scores));
    sds.push(sd(scores));
    const logic = list.map((r) => r.answers.same_logic).filter((x): x is number => x !== undefined);
    if (logic.length > 1) logicSpreads.push(Math.max(...logic) - Math.min(...logic));
    const concept = list.map((r) => r.answers.same_concept).filter((x): x is number => x !== undefined);
    if (concept.length > 1) conceptSpreads.push(Math.max(...concept) - Math.min(...concept));
    const shapes = list.map((r) => r.answers.shape?.choice).filter((x): x is string => x !== undefined);
    if (shapes.length > 1) shapeChanges.push(new Set(shapes).size > 1 ? 1 : 0);
    for (const c of CUTOFFS) {
      const over = scores.filter((s) => s >= c).length;
      const flipped = over > 0 && over < scores.length;
      if (flipped) flips[String(c)] = (flips[String(c)] ?? 0) + 1;
      const m = mean(scores);
      const bucket = Math.abs(m - c) < 0.25 ? "<0.25" : Math.abs(m - c) < 0.5 ? "0.25-0.5" : ">=0.5";
      const k = `${c}:${bucket}`;
      near[k] ??= { flipped: 0, total: 0 };
      near[k].total += 1;
      if (flipped) near[k].flipped += 1;
    }
  }
  const out = {
    label,
    pairs: n,
    passes: expectedPasses,
    rowsPerPair: n > 0 ? rows / n : Number.NaN,
    incompletePairs: incomplete,
    spreadMean: mean(spreads),
    spreadMedian: quantile(spreads, 0.5),
    spreadP90: quantile(spreads, 0.9),
    spreadMax: Math.max(...spreads),
    sdMean: mean(sds),
    logicSpreadMean: mean(logicSpreads),
    conceptSpreadMean: mean(conceptSpreads),
    shapeChangedRate: mean(shapeChanges),
    flipRate: Object.fromEntries(Object.entries(flips).map(([c, k]) => [c, k / n])),
    flipRateByDistance: Object.fromEntries(Object.entries(near).map(([k, v]) => [k, `${v.flipped}/${v.total}`])),
  };
  return out;
}

function stabilityRow(name: string, s: Record<string, number>): (string | number)[] {
  return [
    name,
    s.pairs!,
    s.passes!,
    s.spreadMean!,
    s.spreadMedian!,
    s.spreadP90!,
    s.spreadMax!,
    s.logicSpreadMean!,
    s.conceptSpreadMean!,
    s.shapeChangedRate!,
    (s.flipRate as unknown as Record<string, number>)["1.9"] ?? 0,
  ];
}

function positionEffect(results: Result[]): Record<string, unknown> {
  const scored = withRefactor(results);
  const groups = byKey(scored);
  const means = new Map<string, number>();
  for (const [key, list] of groups) means.set(key, mean(list.map((r) => r.answers.refactor!.score)));
  const buckets = new Map<string, number[]>();
  for (const r of scored) {
    if (r.position === undefined || r.batchSize === undefined) continue;
    const frac = r.position / Math.max(1, r.batchSize - 1);
    const bucket = frac < 0.34 ? "first third" : frac < 0.67 ? "middle" : "last third";
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), r.answers.refactor!.score - means.get(r.key)!]);
  }
  return Object.fromEntries(
    [...buckets.entries()].map(([b, ds]) => [
      b,
      { n: ds.length, meanDeviation: mean(ds), madDeviation: mean(ds.map(Math.abs)) },
    ]),
  );
}

function distribution(results: Result[]): Record<string, unknown> {
  const first = [...firstPass(withRefactor(results)).values()];
  const scores = first.map((r) => r.answers.refactor!.score);
  const bins: Record<string, number> = {};
  for (let b = 0; b < 12; b += 1) bins[`${(b / 4).toFixed(2)}-${((b + 1) / 4).toFixed(2)}`] = 0;
  for (const s of scores)
    bins[
      `${(Math.min(11, Math.floor(s * 4)) / 4).toFixed(2)}-${((Math.min(11, Math.floor(s * 4)) + 1) / 4).toFixed(2)}`
    ]! += 1;
  const conf = first.map((r) => r.answers.refactor!.confidence);
  const shapeCounts: Record<string, number> = {};
  const shapeByLevel: Record<string, Record<string, number>> = {};
  const logicByLevel: Record<string, number[]> = {};
  const conceptByLevel: Record<string, number[]> = {};
  const confByLevel: Record<string, number[]> = {};
  const byCorpus: Record<string, { n: number; over19: number; meanScore: number }> = {};
  const corpusScores: Record<string, number[]> = {};
  for (const r of first) {
    const l = String(level(r.answers.refactor!.score));
    if (r.answers.shape !== undefined) {
      shapeCounts[r.answers.shape.choice] = (shapeCounts[r.answers.shape.choice] ?? 0) + 1;
      shapeByLevel[l] ??= {};
      shapeByLevel[l]![r.answers.shape.choice] = (shapeByLevel[l]![r.answers.shape.choice] ?? 0) + 1;
    }
    if (r.answers.same_logic !== undefined) (logicByLevel[l] ??= []).push(r.answers.same_logic);
    if (r.answers.same_concept !== undefined) (conceptByLevel[l] ??= []).push(r.answers.same_concept);
    (confByLevel[l] ??= []).push(r.answers.refactor!.confidence);
    (corpusScores[r.corpus] ??= []).push(r.answers.refactor!.score);
  }
  for (const [corpus, list] of Object.entries(corpusScores))
    byCorpus[corpus] = { n: list.length, over19: list.filter((s) => s >= 1.9).length, meanScore: mean(list) };
  return {
    pairs: first.length,
    scoreBins: bins,
    over: Object.fromEntries(CUTOFFS.map((c) => [String(c), scores.filter((s) => s >= c).length])),
    confidence: {
      mean: mean(conf),
      p10: quantile(conf, 0.1),
      p50: quantile(conf, 0.5),
      p90: quantile(conf, 0.9),
      under05: conf.filter((c) => c < 0.5).length / conf.length,
    },
    confidenceByLevel: Object.fromEntries(
      Object.entries(confByLevel).map(([l, xs]) => [
        l,
        { n: xs.length, mean: mean(xs), under05: xs.filter((c) => c < 0.5).length / xs.length },
      ]),
    ),
    shapeCounts,
    shapeByLevel,
    logicByLevel: Object.fromEntries(Object.entries(logicByLevel).map(([l, xs]) => [l, mean(xs)])),
    conceptByLevel: Object.fromEntries(Object.entries(conceptByLevel).map(([l, xs]) => [l, mean(xs)])),
    byCorpus,
    widestGap: widestGap(scores),
  };
}

function widestGap(values: number[]): { gap: number; low: number; high: number } {
  const sorted = [...values].sort((a, b) => a - b);
  let best = { gap: 0, low: sorted[0] ?? 0, high: sorted[0] ?? 0 };
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap > best.gap) best = { gap, low: sorted[i - 1]!, high: sorted[i]! };
  }
  return best;
}

interface Labeled {
  key: string;
  merge: boolean;
  shape?: string;
  score: number;
  confidence: number;
  logic: number;
  concept: number;
  shapeChoice?: string;
}

function fitCutoff(cases: Labeled[], value: (c: Labeled) => number): { cutoff: number; separable: boolean } {
  const merges = cases
    .filter((c) => c.merge)
    .map(value)
    .sort((a, b) => a - b);
  const keeps = cases
    .filter((c) => !c.merge)
    .map(value)
    .sort((a, b) => b - a);
  const loMerge = merges[0] ?? Number.NaN;
  const hiKeep = keeps[0] ?? Number.NaN;
  if (loMerge > hiKeep) return { cutoff: (loMerge + hiKeep) / 2, separable: true };
  const observed = [...new Set(cases.map(value))].sort((a, b) => a - b);
  const top = observed[observed.length - 1];
  const candidates = top === undefined ? [] : [...observed, Math.round((top + 0.01) * 100) / 100];
  let best = { cutoff: candidates[0] ?? 0, gain: -Infinity };
  for (const c of candidates) {
    const tp = cases.filter((x) => x.merge && value(x) >= c).length;
    const fp = cases.filter((x) => !x.merge && value(x) >= c).length;
    const fn = cases.filter((x) => x.merge && value(x) < c).length;
    const gain = tp - fp - fn;
    if (gain > best.gain) best = { cutoff: c, gain };
  }
  return { cutoff: best.cutoff, separable: false };
}

function precisionRecall(
  cases: Labeled[],
  value: (c: Labeled) => number,
  cutoff: number,
): { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; accuracy: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const c of cases) {
    const flagged = value(c) >= cutoff;
    if (c.merge && flagged) tp += 1;
    else if (c.merge) fn += 1;
    else if (flagged) fp += 1;
    else tn += 1;
  }
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp > 0 ? tp / (tp + fp) : Number.NaN,
    recall: tp + fn > 0 ? tp / (tp + fn) : Number.NaN,
    accuracy: (tp + tn) / cases.length,
  };
}

function crossValidate(
  cases: Labeled[],
  value: (c: Labeled) => number,
  folds = 5,
): { heldOutAccuracy: number; heldOutFp: number; heldOutFn: number; cutoffs: number[] } {
  const shuffledCases = [...cases].sort((a, b) => (a.key < b.key ? -1 : 1));
  let evaluated = 0;
  let right = 0;
  let fp = 0;
  let fn = 0;
  const cutoffs: number[] = [];
  for (let f = 0; f < folds; f += 1) {
    const test = shuffledCases.filter((_, i) => i % folds === f);
    const train = shuffledCases.filter((_, i) => i % folds !== f);
    if (train.length === 0 || test.length === 0) continue;
    const { cutoff } = fitCutoff(train, value);
    cutoffs.push(cutoff);
    for (const c of test) {
      evaluated += 1;
      const flagged = value(c) >= cutoff;
      if (flagged === c.merge) right += 1;
      else if (flagged) fp += 1;
      else fn += 1;
    }
  }
  return { heldOutAccuracy: evaluated > 0 ? right / evaluated : Number.NaN, heldOutFp: fp, heldOutFn: fn, cutoffs };
}

function labelReport(labels: Record<string, Label>, arm: Map<string, Result>, name: string): Record<string, unknown> {
  const cases: Labeled[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const r = arm.get(key);
    if (r === undefined || r.answers.refactor === undefined) continue;
    cases.push({
      key,
      merge: label.merge,
      ...(label.shape !== undefined ? { shape: label.shape } : {}),
      score: r.answers.refactor.score,
      confidence: r.answers.refactor.confidence,
      logic: r.answers.same_logic ?? Number.NaN,
      concept: r.answers.same_concept ?? Number.NaN,
      ...(r.answers.shape !== undefined ? { shapeChoice: r.answers.shape.choice } : {}),
    });
  }
  const merges = cases.filter((c) => c.merge);
  const keeps = cases.filter((c) => !c.merge);
  const signals: Record<string, (c: Labeled) => number> = {
    score: (c) => c.score,
    same_logic: (c) => c.logic,
    same_concept: (c) => c.concept,
    "min(logic,concept)": (c) => Math.min(c.logic, c.concept),
    "score*conf": (c) => c.score * c.confidence,
  };
  const perSignal: Record<string, unknown> = {};
  for (const [signalName, value] of Object.entries(signals)) {
    const fit = fitCutoff(cases, value);
    perSignal[signalName] = {
      auc: auc(merges.map(value), keeps.map(value)),
      fitted: fit,
      atFitted: precisionRecall(cases, value, fit.cutoff),
      crossValidated: crossValidate(cases, value),
      gap: { loMerge: Math.min(...merges.map(value)), hiKeep: Math.max(...keeps.map(value)) },
    };
  }
  const atCutoffs = Object.fromEntries(CUTOFFS.map((c) => [String(c), precisionRecall(cases, (x) => x.score, c)]));
  const conservative = (t: number) =>
    precisionRecall(cases, (c) => (Math.max(c.logic, c.concept) >= t ? c.score : 0), 1.9);
  const shapeCases = cases.filter((c) => c.shape !== undefined && c.shapeChoice !== undefined);
  const shapeRight = shapeCases.filter((c) => c.shape === c.shapeChoice).length;
  const confusion: Record<string, Record<string, number>> = {};
  for (const c of shapeCases) {
    confusion[c.shape!] ??= {};
    confusion[c.shape!]![c.shapeChoice!] = (confusion[c.shape!]![c.shapeChoice!] ?? 0) + 1;
  }
  const wrong = cases
    .filter((c) => c.score >= 1.9 !== c.merge)
    .map((c) => ({
      key: c.key,
      merge: c.merge,
      score: c.score,
      confidence: c.confidence,
      logic: c.logic,
      concept: c.concept,
    }));
  const unsureBands = [0.3, 0.4, 0.5, 0.6].map((t) => {
    const over = cases.filter((c) => c.score >= 1.9);
    const unsure = over.filter((c) => c.confidence < t);
    const sure = over.filter((c) => c.confidence >= t);
    return {
      unsureBelow: t,
      unsure: unsure.length,
      unsurePrecision: unsure.length > 0 ? unsure.filter((c) => c.merge).length / unsure.length : Number.NaN,
      surePrecision: sure.length > 0 ? sure.filter((c) => c.merge).length / sure.length : Number.NaN,
    };
  });
  return {
    arm: name,
    labeled: cases.length,
    merges: merges.length,
    keeps: keeps.length,
    perSignal,
    atCutoffs,
    conservative: { "logic|concept>=0.5": conservative(0.5), "logic|concept>=0.7": conservative(0.7) },
    shape: {
      cases: shapeCases.length,
      accuracy: shapeCases.length > 0 ? shapeRight / shapeCases.length : Number.NaN,
      confusion,
    },
    unsureBands,
    wrongAt19: wrong,
  };
}

function requestsReport(): Record<string, unknown> {
  const records = readLines<RequestRecord>(path.join(root, "requests.jsonl"));
  const groups = new Map<string, RequestRecord[]>();
  for (const r of records) groups.set(`${r.exp}/${r.arm}`, [...(groups.get(`${r.exp}/${r.arm}`) ?? []), r]);
  const rows: Record<string, unknown> = {};
  let total = 0;
  let totalTokens = 0;
  let totalOk = 0;
  for (const [name, list] of groups) {
    const ok = list.filter((r) => r.ok);
    const ratio = ok.map((r) => r.inputTokens / r.estimate);
    const bytesPerToken = ok.map((r) => r.bytes / r.inputTokens);
    total += list.length;
    totalOk += ok.length;
    totalTokens += ok.reduce((a, r) => a + r.inputTokens, 0);
    rows[name] = {
      requests: list.length,
      ok: ok.length,
      failed: list.length - ok.length,
      statuses: Object.fromEntries(
        [...new Set(list.map((r) => r.status))].map((s) => [String(s), list.filter((r) => r.status === s).length]),
      ),
      inputTokens: ok.reduce((a, r) => a + r.inputTokens, 0),
      msMean: mean(ok.map((r) => r.ms)),
      msP50: quantile(
        ok.map((r) => r.ms),
        0.5,
      ),
      msP90: quantile(
        ok.map((r) => r.ms),
        0.9,
      ),
      actualOverEstimate: { mean: mean(ratio), p10: quantile(ratio, 0.1), p90: quantile(ratio, 0.9) },
      bytesPerToken: {
        mean: mean(bytesPerToken),
        p10: quantile(bytesPerToken, 0.1),
        p90: quantile(bytesPerToken, 0.9),
      },
    };
  }
  return {
    totalRequests: total,
    totalOk,
    totalInputTokens: totalTokens,
    usdAt0042PerMTok: (totalTokens / 1e6) * 0.042,
    byArm: rows,
  };
}

function main(): void {
  say("# Measurement summary");
  say();
  const requests = requestsReport();
  summary.requests = requests;
  say(
    `Requests logged: ${requests.totalRequests} (${requests.totalOk} ok), ${requests.totalInputTokens} input tokens, ~$${(requests.usdAt0042PerMTok as number).toFixed(2)} at $0.042/M.`,
  );
  say();

  const soloArms = fs.existsSync(path.join(root, "solo"))
    ? fs
        .readdirSync(path.join(root, "solo"))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, ""))
    : [];
  const batchedArms = fs.existsSync(path.join(root, "batched"))
    ? fs
        .readdirSync(path.join(root, "batched"))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, ""))
    : [];
  const solo = new Map(soloArms.map((arm) => [arm, loadArm("solo", arm)]));
  const batched = new Map(batchedArms.map((arm) => [arm, loadArm("batched", arm)]));

  const reference = solo.get("all-r1");
  const rows: (string | number)[][] = [];
  const agreements: Record<string, Agreement> = {};
  const add = (name: string, a: Map<string, Result> | undefined, b: Map<string, Result> | undefined) => {
    if (a === undefined || b === undefined || a.size === 0 || b.size === 0) return;
    const g = agreement(a, b);
    if (g.n === 0) return;
    agreements[name] = g;
    rows.push(agreementRow(name, g));
  };
  if (reference !== undefined) {
    const r1 = firstPass(reference);
    add(
      "solo r1 vs solo r2 (noise)",
      r1,
      solo.get("all-r2") !== undefined ? firstPass(solo.get("all-r2")!) : undefined,
    );
    add(
      "solo r1 vs solo r3 (noise)",
      r1,
      solo.get("all-r3") !== undefined ? firstPass(solo.get("all-r3")!) : undefined,
    );
    add(
      "solo r2 vs solo r3 (noise)",
      solo.get("all-r2") !== undefined ? firstPass(solo.get("all-r2")!) : undefined,
      solo.get("all-r3") !== undefined ? firstPass(solo.get("all-r3")!) : undefined,
    );
    for (const kind of ["refactor-only", "logic-only", "concept-only", "shape-only"]) {
      add(`solo all vs solo ${kind}`, r1, solo.get(kind) !== undefined ? firstPass(solo.get(kind)!) : undefined);
    }
    for (const arm of batchedArms) {
      const list = batched.get(arm)!;
      const passes = new Set(list.map((r) => r.repeat)).size;
      add(`solo r1 vs batched ${arm} (pass 1)`, r1, pass(list, 1));
      if (passes > 1) add(`batched ${arm} pass 1 vs pass 2 (noise)`, pass(list, 1), pass(list, 2));
    }
  }
  if (batched.has("long-b40k-fixed")) {
    const base = pass(batched.get("long-b40k-fixed")!, 1);
    for (const arm of batchedArms) {
      if (arm === "long-b40k-fixed") continue;
      add(`batched long-b40k-fixed p1 vs ${arm} p1`, base, pass(batched.get(arm)!, 1));
    }
  }
  summary.agreements = agreements;
  say("## Agreement between arms (refactor score unless noted)");
  say();
  table(AGREEMENT_HEADERS, rows);

  const stabilities: Record<string, unknown> = {};
  const stabilityRows: (string | number)[][] = [];
  for (const [arm, list] of batched) {
    if (new Set(list.map((r) => r.repeat)).size < 2) continue;
    const s = stability(list, `batched ${arm}`) as Record<string, number>;
    stabilities[`batched ${arm}`] = s;
    stabilityRows.push(stabilityRow(`batched ${arm}`, s));
  }
  const soloPasses = ["all-r1", "all-r2", "all-r3"]
    .filter((a) => solo.has(a))
    .flatMap((a) => solo.get(a)!.map((r, i) => ({ ...r, repeat: Number(a.slice(-1)) + i * 0 })));
  if (["all-r1", "all-r2"].every((a) => solo.has(a))) {
    const s = stability(soloPasses, "solo all (passes r1..r3)") as Record<string, number>;
    stabilities["solo all"] = s;
    stabilityRows.push(stabilityRow("solo all", s));
  }
  summary.stability = stabilities;
  say("## Stability across passes");
  say();
  table(
    [
      "arm",
      "pairs",
      "passes",
      "spread mean",
      "median",
      "p90",
      "max",
      "logic spread",
      "concept spread",
      "shape changed",
      "flip rate @1.9",
    ],
    stabilityRows,
  );
  for (const [name, s] of Object.entries(stabilities)) {
    const detail = s as Record<string, unknown>;
    say(
      `- ${name}: ${detail.incompletePairs} pairs missing a pass; flips by distance to cutoff ${JSON.stringify(detail.flipRateByDistance)}`,
    );
  }
  say();

  const positions: Record<string, unknown> = {};
  for (const arm of ["long-b40k-fixed", "long-b40k-shuffled"]) {
    if (batched.has(arm)) positions[arm] = positionEffect(batched.get(arm)!);
  }
  summary.positionEffect = positions;
  say("## Position in the batch");
  say();
  say("```json");
  say(JSON.stringify(positions, null, 2));
  say("```");
  say();

  const costRows: (string | number)[][] = [];
  const costs: Record<string, unknown> = {};
  for (const [arm, list] of [...solo.entries(), ...batched.entries()]) {
    const c = tokensPerPair(list);
    costs[arm] = c;
    costRows.push([arm, c.requests, c.pairsPerRequest, c.tokensPerPair, c.msPerRequest]);
  }
  summary.cost = costs;
  say("## Cost and latency per arm");
  say();
  table(["arm", "requests", "pairs/request", "tokens/pair", "ms/request"], costRows);

  if (reference !== undefined) {
    const d = distribution(reference);
    summary.distribution = d;
    say("## Distribution (solo all-r1)");
    say();
    say("```json");
    say(JSON.stringify(d, null, 2));
    say("```");
    say();
  }

  if (labelsFile !== undefined) {
    const labels = JSON.parse(fs.readFileSync(labelsFile, "utf8")) as Record<string, Label>;
    const reports: Record<string, unknown> = {};
    const candidates: [string, Map<string, Result> | undefined][] = [
      ["solo all-r1", reference !== undefined ? firstPass(reference) : undefined],
      [
        "batched long-b40k-fixed p1",
        batched.has("long-b40k-fixed") ? pass(batched.get("long-b40k-fixed")!, 1) : undefined,
      ],
      ["batched long-b40k-full", batched.has("long-b40k-full") ? pass(batched.get("long-b40k-full")!, 1) : undefined],
      [
        "batched compact-b40k-full",
        batched.has("compact-b40k-full") ? pass(batched.get("compact-b40k-full")!, 1) : undefined,
      ],
    ];
    if (["all-r1", "all-r2", "all-r3"].every((a) => solo.has(a))) {
      const meanMap = new Map<string, Result>();
      for (const [key, list] of byKey(withRefactor(soloPasses))) {
        const first = list[0]!;
        meanMap.set(key, {
          ...first,
          answers: {
            ...first.answers,
            refactor: {
              ...first.answers.refactor!,
              score: mean(list.map((r) => r.answers.refactor!.score)),
              confidence: mean(list.map((r) => r.answers.refactor!.confidence)),
            },
          },
        });
      }
      candidates.push(["solo mean of 3 passes", meanMap]);
    }
    for (const [name, arm] of candidates) {
      if (arm === undefined) continue;
      reports[name] = labelReport(labels, arm, name);
    }
    summary.labels = reports;
    say("## Labeled corpus");
    say();
    say("```json");
    say(JSON.stringify(reports, null, 2));
    say("```");
    say();
  }

  const sweepFile = path.join(root, "sweep", "b10-summary.jsonl");
  if (fs.existsSync(sweepFile)) {
    const sweep = readLines<Record<string, number>>(sweepFile);
    summary.sweep = sweep;
    say("## Concurrency sweep (1,000 pairs, 10 per request)");
    say();
    table(
      ["concurrency", "requests", "failed", "429", "wall ms", "mean ms", "requests/s", "tokens/s"],
      sweep.map((s) => [
        s.concurrency!,
        s.requests!,
        s.failed!,
        s.rateLimited!,
        s.wallMs!,
        s.meanMs!,
        s.requestsPerSecond!,
        s.tokensPerSecond!,
      ]),
    );
  }
  const ceilings = readLines<Record<string, unknown>>(path.join(root, "ceilings", "ceilings.jsonl"));
  if (ceilings.length > 0) {
    summary.ceilings = ceilings;
    say("## Ceilings");
    say();
    say("```json");
    say(JSON.stringify(ceilings, null, 2));
    say("```");
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
