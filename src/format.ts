import type { AnalyzerLocation } from "@kongyo2/similarity-ts";
import { SHAPE_LABELS } from "./families.ts";
import { toRelativePath } from "./snippets.ts";
import type { Family, JevReport, JudgeStats, JudgedPair, Passes, Shape, Thresholds, UnjudgedPair, Verdict } from "./types.ts";

function location(side: AnalyzerLocation, cwd: string): string {
  const range = side.startLine === side.endLine ? String(side.startLine) : `${side.startLine}-${side.endLine}`;
  return `${toRelativePath(side.filePath, cwd)}:${range} ${side.symbolName}`;
}

export function flagOf(verdict: Pick<Verdict, "unsure" | "borderline" | "unstable">): string {
  if (verdict.unstable) return "!";
  if (verdict.unsure) return "?";
  if (verdict.borderline) return "~";
  return " ";
}

function head(score: number, verdict: Pick<Verdict, "unsure" | "borderline" | "unstable">, shape: Shape | undefined): string {
  return `${score.toFixed(2)}${flagOf(verdict)} ${(shape === undefined ? "-" : SHAPE_LABELS[shape]).padEnd(7)}`;
}

function renderFamily(family: Family, cwd: string): string[] {
  const lead = head(family.maxScore, family, family.shape);
  if (family.members.length === 2) return [`${lead}  ${location(family.members[0]!, cwd)} <-> ${location(family.members[1]!, cwd)}`];
  return [lead.trimEnd(), ...family.members.map((member) => `      ${location(member, cwd)}`)];
}

export interface PrettyOptions {
  includeRejected?: boolean;
}

export function formatPrettyReport(report: JevReport, cwd: string, options: PrettyOptions = {}): string {
  const lines = report.families.flatMap((family) => renderFamily(family, cwd));
  if (options.includeRejected && report.rejected.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const pair of report.rejected) {
      lines.push(`${head(pair.judgment.score, pair.verdict, undefined)}  ${location(pair.left, cwd)} <-> ${location(pair.right, cwd)}`);
    }
  }
  return lines.join("\n");
}

export interface JsonPair {
  score: number;
  confidence: number;
  sameLogic: number;
  sameConcept: number;
  shape: Shape;
  shapeConfidence: number;
  unsure: boolean;
  borderline: boolean;
  unstable?: boolean;
  passes?: Passes;
  similarity: number;
  mode: JudgedPair["mode"];
  left: AnalyzerLocation;
  right: AnalyzerLocation;
  instances?: AnalyzerLocation[];
}

export interface JsonFamily {
  score: number;
  shape: Shape;
  unsure: boolean;
  borderline: boolean;
  unstable?: boolean;
  members: AnalyzerLocation[];
}

export interface JsonReport {
  results: JsonPair[];
  families: JsonFamily[];
  rejected?: JsonPair[];
  unjudged?: (Pick<JsonPair, "mode" | "similarity" | "left" | "right" | "instances"> & { reason: UnjudgedPair["reason"]; error: string })[];
  thresholds?: Thresholds;
  stats?: JevReport["stats"];
}

function toJsonPair(pair: JudgedPair, repeated: boolean): JsonPair {
  return {
    score: pair.judgment.score,
    confidence: pair.judgment.confidence,
    sameLogic: pair.judgment.sameLogic,
    sameConcept: pair.judgment.sameConcept,
    shape: pair.judgment.shape,
    shapeConfidence: pair.judgment.shapeConfidence,
    unsure: pair.verdict.unsure,
    borderline: pair.verdict.borderline,
    ...(repeated ? { unstable: pair.verdict.unstable } : {}),
    ...(repeated && pair.judgment.passes !== undefined ? { passes: pair.judgment.passes } : {}),
    similarity: pair.similarity,
    mode: pair.mode,
    left: pair.left,
    right: pair.right,
    ...(pair.instances !== undefined ? { instances: pair.instances } : {}),
  };
}

function toJsonUnjudged(pair: UnjudgedPair): NonNullable<JsonReport["unjudged"]>[number] {
  return {
    mode: pair.mode,
    similarity: pair.similarity,
    left: pair.left,
    right: pair.right,
    ...(pair.instances !== undefined ? { instances: pair.instances } : {}),
    reason: pair.reason,
    error: pair.error,
  };
}

export interface JsonOptions {
  includeRejected?: boolean;
  stats?: boolean;
}

export function toJsonReport(report: JevReport, options: JsonOptions = {}): JsonReport {
  const repeated = report.stats.passes > 1;
  return {
    results: report.results.map((pair) => toJsonPair(pair, repeated)),
    families: report.families.map((family) => ({
      score: family.maxScore,
      shape: family.shape,
      unsure: family.unsure,
      borderline: family.borderline,
      ...(repeated ? { unstable: family.unstable } : {}),
      members: family.members,
    })),
    ...(options.includeRejected ? { rejected: report.rejected.map((pair) => toJsonPair(pair, repeated)) } : {}),
    ...(report.unjudged.length > 0 ? { unjudged: report.unjudged.map(toJsonUnjudged) } : {}),
    ...(options.stats ? { thresholds: report.thresholds, stats: report.stats } : {}),
  };
}

export function formatJsonReport(report: JevReport, options: JsonOptions = {}): string {
  return JSON.stringify(toJsonReport(report, options), null, 2);
}

export function formatStats(stats: JevReport["stats"] & Partial<JudgeStats>, thresholds: Thresholds, counts: { results: number; rejected: number; unjudged: number }): string {
  const parts = [
    `${counts.results} worth refactoring, ${counts.rejected} left as they are${counts.unjudged > 0 ? `, ${counts.unjudged} not judged` : ""}`,
    `${stats.pairCount} pairs from ${stats.fileCount} files`,
    `${stats.requests} requests${stats.cacheHits > 0 ? `, ${stats.cacheHits} answered from the cache` : ""}${stats.passes > 1 ? `, ${stats.passes} passes` : ""}`,
    `${stats.inputTokens.toLocaleString()} input tokens (~$${stats.usd.toFixed(4)})`,
    `${(stats.elapsedMs / 1000).toFixed(1)}s`,
  ];
  const trouble = [stats.retries > 0 ? `${stats.retries} retries` : "", stats.rateLimited > 0 ? `${stats.rateLimited} rate-limited` : "", stats.splits > 0 ? `${stats.splits} splits` : ""].filter((part) => part !== "");
  return `${parts.join("; ")}${trouble.length > 0 ? ` (${trouble.join(", ")})` : ""}; thresholds: min-score ${thresholds.minScore.toFixed(2)}, unsure-below ${thresholds.unsureBelow.toFixed(2)}, margin ${thresholds.margin.toFixed(2)}`;
}
