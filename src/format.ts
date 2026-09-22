import type { AnalyzerLocation } from "@kongyo2/similarity-ts";
import { toRelativePath } from "./snippets.ts";
import type { Family, JevReport, JudgedPair, UnjudgedPair } from "./types.ts";

function location(side: AnalyzerLocation, cwd: string): string {
  const range = side.startLine === side.endLine ? String(side.startLine) : `${side.startLine}-${side.endLine}`;
  return `${toRelativePath(side.filePath, cwd)}:${range} ${side.symbolName}`;
}

function renderFamily(family: Family, cwd: string): string[] {
  const score = family.maxScore.toFixed(2);
  if (family.members.length === 2) return [`${score}  ${location(family.members[0]!, cwd)} <-> ${location(family.members[1]!, cwd)}`];
  return [score, ...family.members.map((member) => `      ${location(member, cwd)}`)];
}

export function formatPrettyReport(report: JevReport, cwd: string): string {
  const lines = report.families.flatMap((family) => renderFamily(family, cwd));
  if (report.rejected !== undefined && report.rejected.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const pair of report.rejected) {
      lines.push(`${pair.judgment.score.toFixed(2)}  ${location(pair.left, cwd)} <-> ${location(pair.right, cwd)}`);
    }
  }
  return lines.join("\n");
}

export interface JsonPair {
  score: number;
  confidence: number;
  sameLogic: number;
  sameConcept: number;
  similarity: number;
  mode: JudgedPair["mode"];
  left: AnalyzerLocation;
  right: AnalyzerLocation;
  instances?: AnalyzerLocation[];
}

export interface JsonFamily {
  score: number;
  members: AnalyzerLocation[];
}

export interface JsonReport {
  results: JsonPair[];
  families: JsonFamily[];
  rejected?: JsonPair[];
  unjudged?: (Pick<JsonPair, "mode" | "similarity" | "left" | "right" | "instances"> & { reason: UnjudgedPair["reason"]; error: string })[];
}

function toJsonPair(pair: JudgedPair): JsonPair {
  return {
    score: pair.judgment.score,
    confidence: pair.judgment.confidence,
    sameLogic: pair.judgment.sameLogic,
    sameConcept: pair.judgment.sameConcept,
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

export function toJsonReport(report: JevReport): JsonReport {
  return {
    results: report.results.map(toJsonPair),
    families: report.families.map((family) => ({ score: family.maxScore, members: family.members })),
    ...(report.rejected !== undefined ? { rejected: report.rejected.map(toJsonPair) } : {}),
    ...(report.unjudged.length > 0 ? { unjudged: report.unjudged.map(toJsonUnjudged) } : {}),
  };
}

export function formatJsonReport(report: JevReport): string {
  return JSON.stringify(toJsonReport(report), null, 2);
}
