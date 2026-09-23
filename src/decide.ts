import type { DetectedPair, JudgedPair, Judgment, Thresholds, Verdict } from "./types.ts";

export interface DecideOptions {
  minScore?: number;
  unsureBelow?: number;
  margin?: number;
}

export const DEFAULT_MIN_SCORE = 1.9;
export const DEFAULT_UNSURE_BELOW = 0.5;
export const DEFAULT_MARGIN = 0.25;

export function thresholds(options: DecideOptions = {}): Thresholds {
  return {
    minScore: options.minScore ?? DEFAULT_MIN_SCORE,
    unsureBelow: options.unsureBelow ?? DEFAULT_UNSURE_BELOW,
    margin: options.margin ?? DEFAULT_MARGIN,
  };
}

export function decide(judgment: Judgment, options: DecideOptions = {}): Verdict {
  const { minScore, unsureBelow, margin } = thresholds(options);
  const refactor = judgment.score >= minScore;
  const unsure = refactor && judgment.confidence < unsureBelow;
  const borderline = Math.abs(judgment.score - minScore) < margin;
  const over = judgment.passes === undefined ? 0 : judgment.passes.scores.filter((score) => score >= minScore).length;
  const unstable = judgment.passes !== undefined && over > 0 && over < judgment.passes.count;
  const notes = [unsure ? "unsure" : "", borderline ? "borderline" : "", unstable ? "unstable" : ""].filter(
    (note) => note !== "",
  );
  return {
    refactor,
    unsure,
    borderline,
    unstable,
    reason: `score${refactor ? ">=" : "<"}${minScore.toFixed(2)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`,
  };
}

export function decidePairs(
  judged: Iterable<{ pair: DetectedPair; judgment: Judgment }>,
  options: DecideOptions = {},
): { results: JudgedPair[]; rejected: JudgedPair[] } {
  const results: JudgedPair[] = [];
  const rejected: JudgedPair[] = [];
  for (const { pair, judgment } of judged) {
    const verdict = decide(judgment, options);
    (verdict.refactor ? results : rejected).push({ ...pair, judgment, verdict });
  }
  const byScore = (x: JudgedPair, y: JudgedPair) => y.judgment.score - x.judgment.score || y.similarity - x.similarity;
  return { results: results.sort(byScore), rejected: rejected.sort(byScore) };
}
