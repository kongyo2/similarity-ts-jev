import type { AnalyzeReport, AnalyzerLocation, AnalyzerMode, AnalyzerWarning, SimilarityPair } from "@kongyo2/similarity-ts";

export type PairMode = AnalyzerMode;

export interface DetectedPair {
  mode: PairMode;
  similarity: number;
  left: AnalyzerLocation;
  right: AnalyzerLocation;
  instances?: AnalyzerLocation[];
}

export interface Snippet {
  path: string;
  lines: string;
  kind: string;
  name: string;
  doc?: string;
  code: string;
}

export interface PairSnippet {
  index: number;
  pair: DetectedPair;
  a: Snippet;
  b: Snippet;
  alsoAt?: string[];
  tokens: number;
}

export type Shape = "remove_copy" | "derive" | "extract_shared";

export interface Passes {
  count: number;
  scores: number[];
  spread: number;
}

export interface Judgment {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  sameLogic: number;
  sameConcept: number;
  shape: Shape;
  shapeConfidence: number;
  shapeProbabilities: Record<string, number>;
  model: string;
  requestId?: string;
  passes?: Passes;
}

export interface Verdict {
  refactor: boolean;
  unsure: boolean;
  borderline: boolean;
  unstable: boolean;
  reason: string;
}

export interface JudgedPair extends DetectedPair {
  judgment: Judgment;
  verdict: Verdict;
}

export type UnjudgedReason = "capped" | "unreadable" | "api";

export interface UnjudgedPair extends DetectedPair {
  reason: UnjudgedReason;
  error: string;
}

export interface DetectionReport {
  analyzedFiles: string[];
  skippedFiles: string[];
  warnings: AnalyzerWarning[];
  pairs: DetectedPair[];
  stats: {
    fileCount: number;
    pairCount: number;
    elapsedMs: number;
  };
}

export interface JudgeStats {
  judged: number;
  unjudged: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  retries: number;
  rateLimited: number;
  splits: number;
  passes: number;
  usd: number;
  elapsedMs: number;
}

export interface Family {
  members: AnalyzerLocation[];
  pairs: number;
  maxScore: number;
  meanScore: number;
  shape: Shape;
  unsure: boolean;
  borderline: boolean;
  unstable: boolean;
}

export interface Thresholds {
  minScore: number;
  unsureBelow: number;
  margin: number;
}

export interface JevReport {
  analyzedFiles: string[];
  skippedFiles: string[];
  warnings: AnalyzerWarning[];
  results: JudgedPair[];
  families: Family[];
  rejected: JudgedPair[];
  rejectedCount: number;
  unjudged: UnjudgedPair[];
  thresholds: Thresholds;
  stats: DetectionReport["stats"] & JudgeStats;
}

export type { AnalyzeReport, AnalyzerLocation, AnalyzerMode, AnalyzerWarning, SimilarityPair };
