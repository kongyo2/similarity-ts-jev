import fs from "node:fs/promises";
import { toRelativePath } from "./snippets.ts";
import type { JevReport, JudgedPair, Thresholds } from "./types.ts";

export type Labels = Record<string, boolean>;

export function parseLabels(parsed: unknown, source: string): Labels {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${source}: labels must be a JSON object from pair keys to true (merge), false (keep), or { "merge": boolean }`);
  const labels: Labels = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "boolean") labels[key] = value;
    else if (typeof value === "object" && value !== null && typeof (value as { merge?: unknown }).merge === "boolean") labels[key] = (value as { merge: boolean }).merge;
    else throw new Error(`${source}: label for ${JSON.stringify(key)} must be true, false, or { "merge": boolean }`);
  }
  return labels;
}

export async function readLabels(filePath: string): Promise<Labels> {
  return parseLabels(JSON.parse(await fs.readFile(filePath, "utf8")), filePath);
}

export function pairKey(pair: Pick<JudgedPair, "left" | "right">, cwd: string): string {
  const side = (location: JudgedPair["left"]) => `${toRelativePath(location.filePath, cwd)}:${location.startLine}:${location.symbolName}`;
  return `${side(pair.left)} <-> ${side(pair.right)}`;
}

export function labelOf(labels: Labels, pair: Pick<JudgedPair, "left" | "right">, cwd: string): boolean | undefined {
  const straight = labels[pairKey(pair, cwd)];
  if (straight !== undefined) return straight;
  return labels[pairKey({ left: pair.right, right: pair.left }, cwd)];
}

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

export interface Gap {
  gap: number;
  low: number;
  high: number;
}

export interface SignalReport {
  auc: number;
  fitted: number;
  separable: boolean;
  lowestMerge: number;
  highestKeep: number;
  atFitted: Confusion;
  holdOut: { accuracy: number; falsePositives: number; falseNegatives: number; cutoffs: number[] };
}

export interface Confusion {
  cutoff: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  accuracy: number;
}

export interface LabelReport {
  labeled: number;
  merges: number;
  keeps: number;
  unmatched: number;
  atCutoff: Confusion;
  signals: { score: SignalReport; sameLogic: SignalReport; sameConcept: SignalReport };
  unsureBand: { unsureBelow: number; reported: number; unsure: number; unsurePrecision: number | null; surePrecision: number | null };
  wrong: { key: string; merge: boolean; score: number; confidence: number; sameLogic: number; sameConcept: number }[];
}

export interface Calibration {
  judged: number;
  thresholds: Thresholds;
  histogram: HistogramBin[];
  over: number;
  borderline: number;
  unsure: number;
  widestGap: Gap;
  gapIsWide: boolean;
  headroom: { highestBelow: number | null; lowestAbove: number | null };
  confidence: { median: number; p10: number; p90: number };
  passes: { count: number; spreadMean: number | null; spreadP90: number | null; unstable: number } | null;
  labels: LabelReport | null;
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function widestGap(values: number[]): Gap {
  const sorted = [...values].sort((x, y) => x - y);
  let best: Gap = { gap: 0, low: sorted[0] ?? 0, high: sorted[0] ?? 0 };
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = Math.round((sorted[i]! - sorted[i - 1]!) * 1_000_000) / 1_000_000;
    if (gap > best.gap) best = { gap, low: sorted[i - 1]!, high: sorted[i]! };
  }
  return best;
}

export function auc(positives: number[], negatives: number[]): number {
  if (positives.length === 0 || negatives.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

interface Labeled {
  key: string;
  merge: boolean;
  pair: JudgedPair;
}

function confusion(cases: Labeled[], value: (item: Labeled) => number, cutoff: number): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const item of cases) {
    const flagged = value(item) >= cutoff;
    if (item.merge && flagged) tp += 1;
    else if (item.merge) fn += 1;
    else if (flagged) fp += 1;
    else tn += 1;
  }
  return { cutoff, tp, fp, fn, tn, precision: tp + fp > 0 ? tp / (tp + fp) : null, recall: tp + fn > 0 ? tp / (tp + fn) : null, accuracy: cases.length > 0 ? (tp + tn) / cases.length : Number.NaN };
}

export function fitCutoff(cases: Labeled[], value: (item: Labeled) => number): { cutoff: number; separable: boolean; lowestMerge: number; highestKeep: number } {
  const merges = cases.filter((item) => item.merge).map(value);
  const keeps = cases.filter((item) => !item.merge).map(value);
  const lowestMerge = merges.length > 0 ? Math.min(...merges) : Number.NaN;
  const highestKeep = keeps.length > 0 ? Math.max(...keeps) : Number.NaN;
  if (lowestMerge > highestKeep) return { cutoff: Math.round(((lowestMerge + highestKeep) / 2) * 100) / 100, separable: true, lowestMerge, highestKeep };
  const observed = [...new Set(cases.map(value))].sort((x, y) => x - y);
  const top = observed[observed.length - 1];
  const candidates = top === undefined ? [] : [...observed, Math.round((top + 0.01) * 100) / 100];
  let best = { cutoff: candidates[0] ?? 0, gain: Number.NEGATIVE_INFINITY };
  for (const candidate of candidates) {
    const c = confusion(cases, value, candidate);
    const gain = c.tp - c.fp - c.fn;
    if (gain > best.gain) best = { cutoff: candidate, gain };
  }
  return { cutoff: best.cutoff, separable: false, lowestMerge, highestKeep };
}

export function holdOut(cases: Labeled[], value: (item: Labeled) => number, folds = 5): SignalReport["holdOut"] {
  const ordered = [...cases].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  let evaluated = 0;
  let right = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const cutoffs: number[] = [];
  const k = Math.min(folds, ordered.length);
  for (let fold = 0; fold < k; fold += 1) {
    const test = ordered.filter((_, i) => i % k === fold);
    const train = ordered.filter((_, i) => i % k !== fold);
    if (train.length === 0) continue;
    const { cutoff } = fitCutoff(train, value);
    cutoffs.push(cutoff);
    for (const item of test) {
      evaluated += 1;
      const flagged = value(item) >= cutoff;
      if (flagged === item.merge) right += 1;
      else if (flagged) falsePositives += 1;
      else falseNegatives += 1;
    }
  }
  return { accuracy: evaluated > 0 ? right / evaluated : Number.NaN, falsePositives, falseNegatives, cutoffs };
}

function signal(cases: Labeled[], value: (item: Labeled) => number): SignalReport {
  const fit = fitCutoff(cases, value);
  return {
    auc: auc(cases.filter((item) => item.merge).map(value), cases.filter((item) => !item.merge).map(value)),
    fitted: fit.cutoff,
    separable: fit.separable,
    lowestMerge: fit.lowestMerge,
    highestKeep: fit.highestKeep,
    atFitted: confusion(cases, value, fit.cutoff),
    holdOut: holdOut(cases, value),
  };
}

export function labelReport(pairs: JudgedPair[], labels: Labels, cwd: string, thresholds: Thresholds): LabelReport {
  const cases: Labeled[] = [];
  let matched = 0;
  for (const pair of pairs) {
    const merge = labelOf(labels, pair, cwd);
    if (merge === undefined) continue;
    matched += 1;
    cases.push({ key: pairKey(pair, cwd), merge, pair });
  }
  const score = (item: Labeled) => item.pair.judgment.score;
  const reported = cases.filter((item) => score(item) >= thresholds.minScore);
  const unsure = reported.filter((item) => item.pair.judgment.confidence < thresholds.unsureBelow);
  const sure = reported.filter((item) => item.pair.judgment.confidence >= thresholds.unsureBelow);
  return {
    labeled: cases.length,
    merges: cases.filter((item) => item.merge).length,
    keeps: cases.filter((item) => !item.merge).length,
    unmatched: Object.keys(labels).length - matched,
    atCutoff: confusion(cases, score, thresholds.minScore),
    signals: {
      score: signal(cases, score),
      sameLogic: signal(cases, (item) => item.pair.judgment.sameLogic),
      sameConcept: signal(cases, (item) => item.pair.judgment.sameConcept),
    },
    unsureBand: {
      unsureBelow: thresholds.unsureBelow,
      reported: reported.length,
      unsure: unsure.length,
      unsurePrecision: unsure.length > 0 ? unsure.filter((item) => item.merge).length / unsure.length : null,
      surePrecision: sure.length > 0 ? sure.filter((item) => item.merge).length / sure.length : null,
    },
    wrong: cases
      .filter((item) => score(item) >= thresholds.minScore !== item.merge)
      .map((item) => ({ key: item.key, merge: item.merge, score: score(item), confidence: item.pair.judgment.confidence, sameLogic: item.pair.judgment.sameLogic, sameConcept: item.pair.judgment.sameConcept })),
  };
}

export const WIDE_GAP = 0.75;

export function calibrate(report: JevReport, cwd: string, labels?: Labels): Calibration {
  const pairs = [...report.results, ...report.rejected];
  const scores = pairs.map((pair) => pair.judgment.score);
  const { minScore, margin, unsureBelow } = report.thresholds;
  const histogram: HistogramBin[] = Array.from({ length: 12 }, (_, i) => ({ from: i / 4, to: (i + 1) / 4, count: 0 }));
  for (const score of scores) histogram[Math.min(11, Math.max(0, Math.floor(score * 4)))]!.count += 1;
  const below = scores.filter((score) => score < minScore);
  const above = scores.filter((score) => score >= minScore);
  const gap = widestGap(scores);
  const confidences = pairs.map((pair) => pair.judgment.confidence);
  const spreads = pairs.map((pair) => pair.judgment.passes?.spread).filter((spread): spread is number => spread !== undefined);
  return {
    judged: pairs.length,
    thresholds: report.thresholds,
    histogram,
    over: above.length,
    borderline: scores.filter((score) => Math.abs(score - minScore) < margin).length,
    unsure: pairs.filter((pair) => pair.verdict.refactor && pair.verdict.unsure).length,
    widestGap: gap,
    gapIsWide: gap.gap >= WIDE_GAP,
    headroom: { highestBelow: below.length > 0 ? Math.max(...below) : null, lowestAbove: above.length > 0 ? Math.min(...above) : null },
    confidence: { median: quantile(confidences, 0.5), p10: quantile(confidences, 0.1), p90: quantile(confidences, 0.9) },
    passes:
      report.stats.passes > 1
        ? { count: report.stats.passes, spreadMean: spreads.length > 0 ? mean(spreads) : null, spreadP90: spreads.length > 0 ? quantile(spreads, 0.9) : null, unstable: pairs.filter((pair) => pair.verdict.unstable).length }
        : null,
    labels: labels !== undefined ? labelReport(pairs, labels, cwd, { minScore, margin, unsureBelow }) : null,
  };
}

const f2 = (n: number | null): string => (n === null || Number.isNaN(n) ? "-" : n.toFixed(2));

export function formatCalibration(c: Calibration): string {
  const lines: string[] = [];
  const { minScore, unsureBelow, margin } = c.thresholds;
  lines.push(`${c.judged} judged pairs; ${c.over} at or over ${minScore.toFixed(2)}, ${c.borderline} within ${margin.toFixed(2)} of it, ${c.unsure} reported with confidence under ${unsureBelow.toFixed(2)}`);
  const widest = Math.max(1, ...c.histogram.map((bin) => bin.count));
  for (const bin of c.histogram) {
    lines.push(`  ${bin.from.toFixed(2)}-${bin.to.toFixed(2)}  ${"#".repeat(Math.round((bin.count / widest) * 40)).padEnd(40)} ${bin.count}`);
  }
  lines.push(
    `widest gap ${c.widestGap.gap.toFixed(2)} between ${c.widestGap.low.toFixed(2)} and ${c.widestGap.high.toFixed(2)}: ${c.gapIsWide ? "the answers separate there; a cutoff anywhere in the gap gives the same list" : "the answers are not separated, so no cutoff is safer than another and the borderline band is where to look"}`,
  );
  lines.push(`headroom: highest score under the cutoff ${f2(c.headroom.highestBelow)}, lowest at or over it ${f2(c.headroom.lowestAbove)}; confidence median ${f2(c.confidence.median)} (p10 ${f2(c.confidence.p10)}, p90 ${f2(c.confidence.p90)})`);
  if (c.passes !== null) {
    lines.push(`${c.passes.count} passes: mean spread ${f2(c.passes.spreadMean)}, p90 ${f2(c.passes.spreadP90)}; ${c.passes.unstable} pairs crossed the cutoff between passes`);
  }
  if (c.labels !== null) {
    const l = c.labels;
    lines.push("");
    lines.push(`labels: ${l.labeled} labeled pairs found (${l.merges} merge, ${l.keeps} keep)${l.unmatched > 0 ? `, ${l.unmatched} labels matched no pair` : ""}`);
    const at = l.atCutoff;
    lines.push(`  at ${at.cutoff.toFixed(2)}: precision ${f2(at.precision)}, recall ${f2(at.recall)}, accuracy ${f2(at.accuracy)} (tp ${at.tp}, fp ${at.fp}, fn ${at.fn}, tn ${at.tn})`);
    for (const [name, s] of [["score", l.signals.score], ["same_logic", l.signals.sameLogic], ["same_concept", l.signals.sameConcept]] as const) {
      lines.push(
        `  ${name.padEnd(12)} AUC ${f2(s.auc)}; fitted cutoff ${s.fitted.toFixed(2)} (${s.separable ? "separable" : "not separable"}: lowest merge ${f2(s.lowestMerge)}, highest keep ${f2(s.highestKeep)}); ` +
          `at the fit precision ${f2(s.atFitted.precision)} recall ${f2(s.atFitted.recall)}; ${s.holdOut.cutoffs.length}-fold hold-out accuracy ${f2(s.holdOut.accuracy)} (fp ${s.holdOut.falsePositives}, fn ${s.holdOut.falseNegatives}; fold cutoffs ${s.holdOut.cutoffs.map((cut) => cut.toFixed(2)).join(" ")})`,
      );
    }
    const band = l.unsureBand;
    lines.push(`  unsure band (confidence < ${band.unsureBelow.toFixed(2)}): ${band.unsure} of ${band.reported} reported; precision ${f2(band.unsurePrecision)} there, ${f2(band.surePrecision)} for the rest`);
    for (const w of l.wrong) {
      lines.push(`  wrong: ${w.score.toFixed(2)} (confidence ${w.confidence.toFixed(2)}, logic ${w.sameLogic.toFixed(2)}, concept ${w.sameConcept.toFixed(2)}) labeled ${w.merge ? "merge" : "keep"}  ${w.key}`);
    }
  }
  return lines.join("\n");
}
