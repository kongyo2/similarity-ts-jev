import type { Judgment, Verdict } from "./types.ts";

export interface DecideOptions {
  minScore?: number;
}

export const DEFAULT_MIN_SCORE = 1.9;

export function decide(judgment: Judgment, options: DecideOptions = {}): Verdict {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const refactor = judgment.score >= minScore;
  return { refactor, reason: `score${refactor ? ">=" : "<"}${minScore.toFixed(2)}` };
}
