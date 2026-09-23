import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { FileJudgeCache } from "../src/cache.ts";
import { calibrate, formatCalibration, pairKey, readLabels } from "../src/calibrate.ts";
import type { Labels } from "../src/calibrate.ts";
import { formatPrettyReport, formatStats } from "../src/format.ts";
import { analyzeWithJev } from "../src/index.ts";
import { buildRecord, saveRecord } from "../src/record.ts";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cache: { type: "string", default: "scripts/.verify-cache.json" },
    all: { type: "boolean", default: false },
    sample: { type: "string" },
    modes: { type: "string", default: "functions,types,classes" },
    exclude: { type: "string", multiple: true, default: [] },
    "min-score": { type: "string", default: "1.9" },
    repeat: { type: "string", default: "1" },
    conventions: { type: "string" },
    json: { type: "string" },
    record: { type: "string" },
    labels: { type: "string" },
    "cross-file-only": { type: "boolean", default: false },
  },
});
if (positionals.length === 0) {
  console.error(
    "usage: verify.ts <paths...> [--labels labels.json] [--repeat n] [--conventions text] [--record run.json]",
  );
  process.exit(1);
}

const cwd = process.cwd();
const cache = await FileJudgeCache.load(path.resolve(cwd, flags.cache));
const client = new TypeSafeClient({ timeout: 120_000, logLevel: "warn" });
const minScore = Number(flags["min-score"]);

const report = await analyzeWithJev(client, {
  detect: {
    similarityTs: {
      paths: positionals,
      cwd,
      modes: flags.modes.split(",") as ("functions" | "types" | "classes" | "overlap")[],
      exclude: flags.exclude,
      crossFileOnly: flags["cross-file-only"],
    },
  },
  cache,
  minScore,
  repeat: Number(flags.repeat),
  ...(flags.conventions !== undefined ? { conventions: flags.conventions } : {}),
  ...(flags.sample !== undefined ? { maxPairs: Number(flags.sample) } : {}),
  onProgress: (p) =>
    process.stderr.write(`\r  judged ${p.judged}/${p.total} (${p.requests} requests, ${p.unjudged} failed)   `),
});
process.stderr.write("\n");
await cache.save(path.resolve(cwd, flags.cache));

const all = [...report.results, ...report.rejected];
console.log(`\n${"=".repeat(100)}`);
console.log("score  conf  logic concept shape          mode      pair");
for (const pair of all) {
  const j = pair.judgment;
  const extra = pair.instances !== undefined ? ` (${pair.instances.length} places)` : "";
  console.log(
    `${j.score.toFixed(2)}   ${j.confidence.toFixed(2)}  ${j.sameLogic.toFixed(2)}  ${j.sameConcept.toFixed(2)}    ${j.shape.padEnd(14)} ${pair.mode.padEnd(9)} ${pairKey(pair, cwd)}${extra}`,
  );
}

const labels: Labels | undefined =
  flags.labels !== undefined ? await readLabels(path.resolve(cwd, flags.labels)) : undefined;
console.log(`\n${formatCalibration(calibrate(report, cwd, labels))}`);
console.log(
  `\n${formatStats(report.stats, report.thresholds, { results: report.results.length, rejected: report.rejectedCount, unjudged: report.unjudged.length })}`,
);
for (const u of report.unjudged.slice(0, 5)) console.log(`  unjudged: ${u.error}`);
if (flags.json !== undefined) await fs.writeFile(path.resolve(cwd, flags.json), JSON.stringify(report, null, 2));
if (flags.record !== undefined) await saveRecord(buildRecord(report, cwd), path.resolve(cwd, flags.record));
if (flags.all) console.log(`\n${formatPrettyReport(report, cwd, { includeRejected: true })}`);
