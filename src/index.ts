import path from "node:path";
import { decidePairs, thresholds } from "./decide.ts";
import type { DecideOptions } from "./decide.ts";
import { detect } from "./detect.ts";
import type { DetectOptions } from "./detect.ts";
import { groupFamilies } from "./families.ts";
import { judgePairs } from "./judge.ts";
import type { JudgeClient, JudgeOptions } from "./judge.ts";
import { pairTokens } from "./questions.ts";
import type { RecordedPair } from "./record.ts";
import { SnippetReader } from "./snippets.ts";
import type { SnippetOptions } from "./snippets.ts";
import type { DetectedPair, DetectionReport, JevReport, PairSnippet, UnjudgedPair } from "./types.ts";

export interface JudgeReportOptions extends JudgeOptions, DecideOptions, SnippetOptions {
  maxPairs?: number;
}

export function orderPairs(pairs: DetectedPair[]): DetectedPair[] {
  return [...pairs].sort((x, y) => y.similarity - x.similarity);
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
      unreadable.push({ ...pair, reason: "capped", error: `over the --max-pairs limit (${limit})` });
      continue;
    }
    try {
      const [a, b] = await Promise.all([reader.snippet(pair.left, pair.mode), reader.snippet(pair.right, pair.mode)]);
      const alsoAt = pair.instances
        ?.filter((location) => location !== pair.left && location !== pair.right)
        .map((location) => `${reader.relative(location.filePath)}:${location.startLine}-${location.endLine}`);
      const snippet: PairSnippet = {
        index,
        pair,
        a,
        b,
        ...(alsoAt !== undefined && alsoAt.length > 0 ? { alsoAt } : {}),
        tokens: 0,
      };
      snippet.tokens = pairTokens(snippet);
      snippets.push(snippet);
    } catch (error) {
      unreadable.push({
        ...pair,
        reason: "unreadable",
        error: `could not read the source: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { snippets, unreadable };
}

export async function judgeReport(
  detection: DetectionReport,
  client: JudgeClient,
  options: JudgeReportOptions = {},
): Promise<JevReport> {
  const started = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const { snippets, unreadable } = await readSnippets(orderPairs(detection.pairs), options);
  const unjudged: UnjudgedPair[] = [...unreadable];

  const { maxPairs: _cap, minScore: _min, unsureBelow: _unsure, margin: _margin, ...judgeOptions } = options;
  const { judgments, failures, stats } = await judgePairs(snippets, client, {
    ...judgeOptions,
    repository: options.repository ?? path.basename(path.resolve(cwd)),
  });

  const judged: RecordedPair[] = [];
  for (const snippet of snippets) {
    const judgment = judgments.get(snippet.index);
    if (judgment === undefined) {
      unjudged.push({ ...snippet.pair, reason: "api", error: failures.get(snippet.index) ?? "no answer" });
      continue;
    }
    judged.push({ pair: snippet.pair, judgment });
  }
  const { results, rejected } = decidePairs(judged, options);

  return {
    analyzedFiles: detection.analyzedFiles,
    skippedFiles: detection.skippedFiles,
    warnings: detection.warnings,
    results,
    families: groupFamilies(results),
    rejected,
    rejectedCount: rejected.length,
    unjudged,
    thresholds: thresholds(options),
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
export { DEFAULT_MARGIN, DEFAULT_MIN_SCORE, DEFAULT_UNSURE_BELOW, decide, thresholds } from "./decide.ts";
export type { DecideOptions } from "./decide.ts";
export { SHAPE_LABELS, groupFamilies } from "./families.ts";
export {
  AdaptiveLimiter,
  DEFAULT_CONCURRENCY,
  DEFAULT_RETRIES,
  USD_PER_MILLION_INPUT_TOKENS,
  isRejection,
  judgePairs,
  mergePasses,
  requestHash,
  toJudgment,
} from "./judge.ts";
export type {
  JudgeCache,
  JudgeClient,
  JudgeOptions,
  JudgeOutcome,
  JudgeRejection,
  JudgeRequest,
  JudgeResponse,
} from "./judge.ts";
export { CACHE_VERSION, FileJudgeCache } from "./cache.ts";
export type { CacheEntry, CacheFile } from "./cache.ts";
export {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_PAIRS_PER_REQUEST,
  MAX_REQUEST_TOKENS,
  REFACTOR_LEVELS,
  REFACTOR_QUESTION,
  SAME_CONCEPT,
  SAME_LOGIC,
  SHAPES,
  SHAPE_OPTIONS,
  SHAPE_QUESTION,
  TASK,
  batchPairs,
  buildState,
  estimateTokens,
  pairQuestions,
  pairTokens,
  questionIds,
} from "./questions.ts";
export type { BatchOptions, QuestionIds, StateOptions } from "./questions.ts";
export { SnippetReader, toRelativePath } from "./snippets.ts";
export type { SnippetOptions } from "./snippets.ts";
export { flagOf, formatJsonReport, formatPrettyReport, formatStats, toJsonReport } from "./format.ts";
export type { JsonFamily, JsonOptions, JsonPair, JsonReport, PrettyOptions } from "./format.ts";
export { RECORD_SCHEMA, buildRecord, loadRecord, replayRecord, saveRecord } from "./record.ts";
export type { RecordedPair, RunRecord } from "./record.ts";
export {
  WIDE_GAP,
  auc,
  calibrate,
  fitCutoff,
  formatCalibration,
  holdOut,
  labelOf,
  labelReport,
  pairKey,
  widestGap,
} from "./calibrate.ts";
export type { Calibration, Confusion, Gap, HistogramBin, LabelReport, Labels, SignalReport } from "./calibrate.ts";
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
  Passes,
  Shape,
  Snippet,
  Thresholds,
  UnjudgedPair,
  UnjudgedReason,
  Verdict,
} from "./types.ts";
