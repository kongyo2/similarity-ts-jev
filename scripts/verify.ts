import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { createAdapterClient } from "./adapter.ts";
import { FileJudgeCache } from "../src/cache.ts";
import { formatPrettyReport } from "../src/format.ts";
import { analyzeWithJev } from "../src/index.ts";
import type { JudgedPair } from "../src/types.ts";
import { toRelativePath } from "../src/snippets.ts";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cache: { type: "string", default: "scripts/.verify-cache.json" },
    all: { type: "boolean", default: false },
    sample: { type: "string" },
    modes: { type: "string", default: "functions,types,classes" },
    exclude: { type: "string", multiple: true, default: [] },
    "min-score": { type: "string", default: "2" },
    json: { type: "string" },
    labels: { type: "string" },
    "cross-file-only": { type: "boolean", default: false },
  },
});
if (positionals.length === 0) {
  console.error("usage: verify.ts <paths...>");
  process.exit(1);
}

const cwd = process.cwd();
const cache = await FileJudgeCache.load(path.resolve(cwd, flags.cache));
const client = await createAdapterClient();
const minScore = Number(flags["min-score"]);

const started = Date.now();
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
  includeRejected: true,
  minScore,
  ...(flags.sample !== undefined ? { maxPairs: Number(flags.sample) } : {}),
  onProgress: (p) => process.stderr.write(`\r  judged ${p.judged}/${p.total} (${p.requests} requests, ${p.unjudged} failed)   `),
});
process.stderr.write("\n");
await cache.save(path.resolve(cwd, flags.cache));

const key = (pair: JudgedPair) =>
  `${toRelativePath(pair.left.filePath, cwd)}:${pair.left.startLine}:${pair.left.symbolName} <-> ${toRelativePath(pair.right.filePath, cwd)}:${pair.right.startLine}:${pair.right.symbolName}`;
const all = [...report.results, ...(report.rejected ?? [])].sort((x, y) => y.judgment.score - x.judgment.score);

console.log(`\n${"=".repeat(100)}`);
console.log("score  conf  logic concept mode      pair");
for (const pair of all) {
  const j = pair.judgment;
  const extra = pair.instances !== undefined ? ` (${pair.instances.length} places)` : "";
  console.log(`${j.score.toFixed(2)}   ${j.confidence.toFixed(2)}  ${j.sameLogic.toFixed(2)}  ${j.sameConcept.toFixed(2)}    ${pair.mode.padEnd(9)} ${key(pair)}${extra}`);
}

console.log(`\nhistogram of refactor scores (${all.length} pairs):`);
const bins = new Array<number>(13).fill(0);
for (const pair of all) bins[Math.min(12, Math.floor(pair.judgment.score * 4))]! += 1;
for (const [i, count] of bins.entries()) console.log(`  ${(i / 4).toFixed(2)}-${((i + 1) / 4).toFixed(2)}  ${"#".repeat(Math.min(count, 80))}${count > 80 ? "+" : ""} ${count}`);

if (flags.labels !== undefined) {
  const labels = JSON.parse(await fs.readFile(path.resolve(cwd, flags.labels), "utf8")) as Record<string, boolean>;
  const labeled = all.filter((pair) => labels[key(pair)] !== undefined);
  const merges = labeled.filter((pair) => labels[key(pair)] === true).map((pair) => pair.judgment.score).sort((x, y) => x - y);
  const keeps = labeled.filter((pair) => labels[key(pair)] === false).map((pair) => pair.judgment.score).sort((x, y) => y - x);
  console.log(`\nlabels: ${labeled.length} of ${Object.keys(labels).length} labeled pairs found (${merges.length} merge, ${keeps.length} keep)`);
  if (merges.length > 0 && keeps.length > 0) {
    console.log(`  lowest merge score ${merges[0]!.toFixed(2)}, highest keep score ${keeps[0]!.toFixed(2)}, gap ${(merges[0]! - keeps[0]!).toFixed(2)}, middle ${((merges[0]! + keeps[0]!) / 2).toFixed(2)}`);
  }
  const wrong = labeled.filter((pair) => (pair.judgment.score >= minScore) !== labels[key(pair)]);
  console.log(`  at min-score ${minScore}: ${labeled.length - wrong.length}/${labeled.length} correct`);
  for (const pair of wrong) console.log(`    wrong: ${pair.judgment.score.toFixed(2)} labeled ${labels[key(pair)] ? "merge" : "keep"}  ${key(pair)}`);
}

const s = report.stats;
console.log(`\n${report.results.length} worth refactoring, ${report.rejectedCount} left, ${report.unjudged.length} unjudged; ${s.requests} requests, ${s.cacheHits} cache hits, ${s.inputTokens} input tokens, ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const u of report.unjudged.slice(0, 5)) console.log(`  unjudged: ${u.error}`);
if (flags.json !== undefined) await fs.writeFile(path.resolve(cwd, flags.json), JSON.stringify(report, null, 2));
if (flags.all) console.log(`\n${formatPrettyReport(report, cwd)}`);
