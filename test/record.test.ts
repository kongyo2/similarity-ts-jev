import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { decide, thresholds } from "../src/decide.ts";
import { RECORD_SCHEMA, buildRecord, loadRecord, replayRecord, saveRecord } from "../src/record.ts";
import type { JevReport, JudgedPair } from "../src/types.ts";
import { judgment, location, pair } from "./helpers.ts";

function judged(index: number, score: number): JudgedPair {
  const j = judgment(score, { confidence: 0.3 });
  return { ...pair(location(`/r/a${index}.ts`, 1, 5, `a${index}`), location(`/r/b${index}.ts`, 1, 5, `b${index}`)), judgment: j, verdict: decide(j) };
}

const pairs = [judged(0, 2.6), judged(1, 2.0), judged(2, 1.2)];
const report: JevReport = {
  analyzedFiles: ["/r/a0.ts"],
  skippedFiles: [],
  warnings: [{ message: "w" }],
  results: pairs.filter((p) => p.verdict.refactor),
  families: [],
  rejected: pairs.filter((p) => !p.verdict.refactor),
  rejectedCount: 1,
  unjudged: [{ ...pair(location("/r/u.ts", 1, 2), location("/r/v.ts", 1, 2)), reason: "api", error: "boom" }],
  thresholds: thresholds(),
  stats: { fileCount: 3, pairCount: 4, elapsedMs: 5, judged: 3, unjudged: 1, requests: 2, inputTokens: 1000, outputTokens: 10, cacheHits: 0, retries: 0, rateLimited: 0, splits: 0, passes: 1, usd: 0.00004 },
};

describe("run records", () => {
  it("keeps every judgment and the thresholds, and replays them under new thresholds without requests", async () => {
    const record = buildRecord(report, "/r");
    assert.equal(record.schema, RECORD_SCHEMA);
    assert.equal(record.pairs.length, 3, "rejected pairs are recorded too");
    assert.equal(record.model, "jev");
    assert.deepEqual(record.thresholds, thresholds());
    assert.ok(!("verdict" in record.pairs[0]!), "verdicts are re-decided on replay");
    const replayed = replayRecord(record, { minScore: 2.5, unsureBelow: 0.2 });
    assert.deepEqual(replayed.results.map((p) => p.left.symbolName), ["a0"]);
    assert.equal(replayed.rejectedCount, 2);
    assert.equal(replayed.results[0]!.verdict.unsure, false);
    assert.equal(replayed.thresholds.minScore, 2.5);
    assert.deepEqual(replayed.stats, report.stats, "the recorded run's spend and timing stay visible");
    assert.deepEqual(replayed.unjudged, report.unjudged);
    assert.deepEqual(replayed.warnings, report.warnings);
    const lenient = replayRecord(record, { minScore: 1.0 });
    assert.equal(lenient.results.length, 3);
    assert.equal(lenient.families.length, 3);
  });

  it("round-trips through a file and refuses other files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "similarity-ts-jev-record-"));
    try {
      const file = path.join(dir, "nested", "run.json");
      await saveRecord(buildRecord(report, "/r"), file);
      const loaded = await loadRecord(file);
      assert.equal(loaded.pairs.length, 3);
      assert.equal(loaded.cwd, path.resolve("/r"));
      const other = path.join(dir, "other.json");
      await fs.writeFile(other, JSON.stringify({ version: 2, entries: {} }));
      await assert.rejects(loadRecord(other), /not a similarity-ts-jev run record/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
