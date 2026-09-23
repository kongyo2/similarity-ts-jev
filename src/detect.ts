import { analyzeProject } from "@kongyo2/similarity-ts";
import type { AnalyzeProjectOptions, AnalyzerLocation, SimilarityPair } from "@kongyo2/similarity-ts";
import { FRAGMENT_KIND, mergePairs, runFallow } from "./fallow.ts";
import type { FallowOptions } from "./fallow.ts";
import type { DetectedPair, DetectionReport } from "./types.ts";

export interface DetectOptions {
  similarityTs: AnalyzeProjectOptions;
  fallow?: Omit<FallowOptions, "cwd" | "paths" | "exclude" | "sameFileOnly" | "crossFileOnly"> &
    Partial<Pick<FallowOptions, "cwd" | "paths" | "exclude" | "sameFileOnly" | "crossFileOnly">>;
}

export async function detect(options: DetectOptions): Promise<DetectionReport> {
  const started = Date.now();
  const cwd = options.similarityTs.cwd ?? process.cwd();
  const [report, fallow] = await Promise.all([
    analyzeProject(options.similarityTs),
    runFallow({
      cwd,
      paths: options.similarityTs.paths,
      ...(options.similarityTs.exclude !== undefined ? { exclude: options.similarityTs.exclude } : {}),
      ...(options.similarityTs.sameFileOnly !== undefined ? { sameFileOnly: options.similarityTs.sameFileOnly } : {}),
      ...(options.similarityTs.crossFileOnly !== undefined
        ? { crossFileOnly: options.similarityTs.crossFileOnly }
        : {}),
      ...options.fallow,
    }),
  ]);
  const pairs = mergePairs(report.results.map(fromSimilarityTs), fallow.pairs);
  return {
    analyzedFiles: report.analyzedFiles,
    skippedFiles: report.skippedFiles,
    warnings: report.warnings,
    pairs,
    stats: { fileCount: report.stats.fileCount, pairCount: pairs.length, elapsedMs: Date.now() - started },
  };
}

function fromSimilarityTs(pair: SimilarityPair): DetectedPair {
  const location = (side: AnalyzerLocation): AnalyzerLocation =>
    pair.mode === "overlap" ? { ...side, kind: FRAGMENT_KIND } : side;
  return { mode: pair.mode, similarity: pair.similarity, left: location(pair.left), right: location(pair.right) };
}
