import path from "node:path";
import { DEFAULT_MIN_SCORE, decide } from "./decide.ts";
import type { DecideOptions } from "./decide.ts";
import { detect } from "./detect.ts";
import type { DetectOptions } from "./detect.ts";
import { groupFamilies } from "./families.ts";
import { judgePairs } from "./judge.ts";
import type { JudgeClient, JudgeOptions } from "./judge.ts";
import { pairTokens } from "./questions.ts";
import { SnippetReader } from "./snippets.ts";
import type { SnippetOptions } from "./snippets.ts";
import type { DetectedPair, DetectionReport, JevReport, JudgedPair, PairSnippet, UnjudgedPair } from "./types.ts";

export interface JudgeReportOptions extends JudgeOptions, DecideOptions, SnippetOptions {
  includeRejected?: boolean;
  maxPairs?: number;
}

export async function readSnippets(
  pairs: DetectedPair[],
  options: SnippetOptions & { maxPairs?: number } = {},
): Promise<{ snippets: PairSnippet[]; unreadable: UnjudgedPair[] }> {
  const reader = new SnippetReader(options);
  const limit = options.maxPairs ?? Number.POSITIVE_INFINITY;
  const snippets: PairSnippet[] = [];
  const unreadable: UnjudgedPair[] = [];
  for (const [index, pair] of pairs.entries()) {
    if (index >= limit) {
      unreadable.push({ ...pair, error: `not judged: over the --max-pairs limit (${limit})` });
      continue;
    }
    try {
      const [a, b] = await Promise.all([reader.snippet(pair.left, pair.mode), reader.snippet(pair.right, pair.mode)]);
      const alsoAt = pair.instances
        ?.filter((location) => location !== pair.left && location !== pair.right)
        .map((location) => `${reader.relative(location.filePath)}:${location.startLine}-${location.endLine}`);
      const snippet: PairSnippet = { index, pair, a, b, ...(alsoAt !== undefined && alsoAt.length > 0 ? { alsoAt } : {}), tokens: 0 };
      snippet.tokens = pairTokens(snippet);
      snippets.push(snippet);
    } catch (error) {
      unreadable.push({ ...pair, error: `could not read the source: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { snippets, unreadable };
}

export async function judgeReport(detection: DetectionReport, client: JudgeClient, options: JudgeReportOptions = {}): Promise<JevReport> {
  const started = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const ordered = [...detection.pairs].sort((x, y) => y.similarity - x.similarity);
  const { snippets, unreadable } = await readSnippets(ordered, options);
  const unjudged: UnjudgedPair[] = [...unreadable];

  const { maxPairs: _cap, includeRejected: _include, minScore: _min, ...judgeOptions } = options;
  const { judgments, failures, stats } = await judgePairs(snippets, client, {
    ...judgeOptions,
    repository: options.repository ?? path.basename(path.resolve(cwd)),
  });

  const results: JudgedPair[] = [];
  const rejected: JudgedPair[] = [];
  for (const snippet of snippets) {
    const judgment = judgments.get(snippet.index);
    if (judgment === undefined) {
      unjudged.push({ ...snippet.pair, error: failures.get(snippet.index) ?? "no answer" });
      continue;
    }
    const verdict = decide(judgment, options);
    (verdict.refactor ? results : rejected).push({ ...snippet.pair, judgment, verdict });
  }
  const byScore = (x: JudgedPair, y: JudgedPair) => y.judgment.score - x.judgment.score || y.similarity - x.similarity;
  results.sort(byScore);
  rejected.sort(byScore);

  return {
    analyzedFiles: detection.analyzedFiles,
    skippedFiles: detection.skippedFiles,
    warnings: detection.warnings,
    results,
    families: groupFamilies(results),
    ...(options.includeRejected ? { rejected } : {}),
    rejectedCount: rejected.length,
    unjudged,
    thresholds: { minScore: options.minScore ?? DEFAULT_MIN_SCORE },
    stats: { ...detection.stats, ...stats, elapsedMs: Date.now() - started },
  };
}

export interface AnalyzeWithJevOptions extends JudgeReportOptions {
  detect: DetectOptions;
}

export async function analyzeWithJev(client: JudgeClient, options: AnalyzeWithJevOptions): Promise<JevReport> {
  const { detect: detectOptions, ...rest } = options;
  const detection = await detect(detectOptions);
  return judgeReport(detection, client, { cwd: detectOptions.similarityTs.cwd ?? process.cwd(), ...rest });
}

export type { AnalyzeProjectOptions } from "@kongyo2/similarity-ts";
export { detect } from "./detect.ts";
export type { DetectOptions } from "./detect.ts";
export { FALLOW_MODES, FallowError } from "./fallow.ts";
export type { FallowMode, FallowOptions } from "./fallow.ts";
export { DEFAULT_MIN_SCORE, decide } from "./decide.ts";
export type { DecideOptions } from "./decide.ts";
export { groupFamilies } from "./families.ts";
export { judgePairs, requestHash, toJudgment } from "./judge.ts";
export type { JudgeCache, JudgeClient, JudgeOptions, JudgeOutcome, JudgeRequest, JudgeResponse } from "./judge.ts";
export { FileJudgeCache } from "./cache.ts";
export type { CacheEntry, CacheFile } from "./cache.ts";
export { REFACTOR_LEVELS, REFACTOR_QUESTION, batchPairs, buildState, estimateTokens, pairQuestions, pairTokens, questionIds } from "./questions.ts";
export type { BatchOptions } from "./questions.ts";
export { SnippetReader, toRelativePath } from "./snippets.ts";
export type { SnippetOptions } from "./snippets.ts";
export { formatJsonReport, formatPrettyReport, toJsonReport } from "./format.ts";
export type { JsonFamily, JsonPair, JsonReport } from "./format.ts";
export type {
  DetectedPair,
  DetectionReport,
  Family,
  JevReport,
  JudgeStats,
  JudgedPair,
  Judgment,
  PairMode,
  PairSnippet,
  Snippet,
  UnjudgedPair,
  Verdict,
} from "./types.ts";
