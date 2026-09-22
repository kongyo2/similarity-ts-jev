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

export interface Judgment {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  sameLogic: number;
  sameConcept: number;
  model: string;
  requestId?: string;
}

export interface Verdict {
  refactor: boolean;
  reason: string;
}

export interface JudgedPair extends DetectedPair {
  judgment: Judgment;
  verdict: Verdict;
}

export interface UnjudgedPair extends DetectedPair {
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
  elapsedMs: number;
}

export interface Family {
  members: AnalyzerLocation[];
  pairs: number;
  maxScore: number;
  meanScore: number;
}

export interface JevReport {
  analyzedFiles: string[];
  skippedFiles: string[];
  warnings: AnalyzerWarning[];
  results: JudgedPair[];
  families: Family[];
  rejected?: JudgedPair[];
  rejectedCount: number;
  unjudged: UnjudgedPair[];
  thresholds: { minScore: number };
  stats: DetectionReport["stats"] & JudgeStats;
}

export type { AnalyzeReport, AnalyzerLocation, AnalyzerMode, AnalyzerWarning, SimilarityPair };
