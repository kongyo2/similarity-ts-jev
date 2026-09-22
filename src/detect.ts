import path from "node:path";
import { analyzeProject } from "@kongyo2/similarity-ts";
import type { AnalyzeProjectOptions, AnalyzerLocation, SimilarityPair } from "@kongyo2/similarity-ts";
import { FRAGMENT_KIND, runFallow, samePair, unionLocations } from "./fallow.ts";
import type { FallowOptions } from "./fallow.ts";
import type { DetectedPair, DetectionReport } from "./types.ts";

export interface DetectOptions {
  similarityTs: AnalyzeProjectOptions;
  fallow?: Omit<FallowOptions, "cwd" | "paths" | "exclude"> & Partial<Pick<FallowOptions, "cwd" | "paths" | "exclude">>;
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
  const location = (side: AnalyzerLocation): AnalyzerLocation => (pair.mode === "overlap" ? { ...side, kind: FRAGMENT_KIND } : side);
  return { mode: pair.mode, similarity: pair.similarity, left: location(pair.left), right: location(pair.right) };
}

export function mergePairs(declarationPairs: DetectedPair[], fragmentPairs: DetectedPair[]): DetectedPair[] {
  const merged: DetectedPair[] = declarationPairs.map((pair) => ({ ...pair }));
  const byFiles = new Map<string, DetectedPair[]>();
  for (const pair of merged) {
    const key = fileKey(pair);
    byFiles.set(key, [...(byFiles.get(key) ?? []), pair]);
  }
  for (const pair of fragmentPairs) {
    const candidates = byFiles.get(fileKey(pair)) ?? [];
    const match = candidates.find((candidate) => samePair(candidate, pair));
    if (match === undefined) {
      merged.push(pair);
      byFiles.set(fileKey(pair), [...candidates, pair]);
      continue;
    }
    const members = unionLocations(match.instances ?? [match.left, match.right], pair.instances ?? [pair.left, pair.right]);
    if (members.length > 2) match.instances = members;
  }
  return merged;
}

function fileKey(pair: DetectedPair): string {
  return [pair.left.filePath, pair.right.filePath].map((p) => path.resolve(p)).sort().join("\n");
}
