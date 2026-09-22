import fs from "node:fs/promises";
import path from "node:path";
import { decide, thresholds } from "./decide.ts";
import type { DecideOptions } from "./decide.ts";
import { groupFamilies } from "./families.ts";
import type { DetectedPair, JevReport, JudgedPair, Judgment, Thresholds, UnjudgedPair } from "./types.ts";

export const RECORD_SCHEMA = "similarity-ts-jev/run/1";

export interface RecordedPair {
  pair: DetectedPair;
  judgment: Judgment;
}

export interface RunRecord {
  schema: typeof RECORD_SCHEMA;
  recorded: string;
  cwd: string;
  model: string | null;
  thresholds: Thresholds;
  analyzedFiles: string[];
  skippedFiles: string[];
  warnings: JevReport["warnings"];
  stats: JevReport["stats"];
  pairs: RecordedPair[];
  unjudged: UnjudgedPair[];
}

export function buildRecord(report: JevReport, cwd: string): RunRecord {
  const judged = [...report.results, ...report.rejected];
  const model = judged[0]?.judgment.model ?? null;
  return {
    schema: RECORD_SCHEMA,
    recorded: new Date().toISOString(),
    cwd: path.resolve(cwd),
    model,
    thresholds: report.thresholds,
    analyzedFiles: report.analyzedFiles,
    skippedFiles: report.skippedFiles,
    warnings: report.warnings,
    stats: report.stats,
    pairs: judged.map((pair) => {
      const { judgment, verdict: _verdict, ...detected } = pair;
      return { pair: detected, judgment };
    }),
    unjudged: report.unjudged,
  };
}

export async function saveRecord(record: RunRecord, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function loadRecord(filePath: string): Promise<RunRecord> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<RunRecord>;
  if (parsed.schema !== RECORD_SCHEMA || !Array.isArray(parsed.pairs)) throw new Error(`${filePath} is not a similarity-ts-jev run record`);
  return parsed as RunRecord;
}

export function replayRecord(record: RunRecord, options: DecideOptions = {}): JevReport {
  const results: JudgedPair[] = [];
  const rejected: JudgedPair[] = [];
  for (const { pair, judgment } of record.pairs) {
    const verdict = decide(judgment, options);
    (verdict.refactor ? results : rejected).push({ ...pair, judgment, verdict });
  }
  const byScore = (x: JudgedPair, y: JudgedPair) => y.judgment.score - x.judgment.score || y.similarity - x.similarity;
  results.sort(byScore);
  rejected.sort(byScore);
  return {
    analyzedFiles: record.analyzedFiles,
    skippedFiles: record.skippedFiles,
    warnings: record.warnings,
    results,
    families: groupFamilies(results),
    rejected,
    rejectedCount: rejected.length,
    unjudged: record.unjudged,
    thresholds: thresholds(options),
    stats: { ...record.stats },
  };
}
