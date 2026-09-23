import path from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { FileJudgeCache } from "../src/cache.ts";
import { analyzeWithJev } from "../src/index.ts";
import { formatPrettyReport } from "../src/format.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "test", "fixtures", "project");
const cacheFile = path.join(root, "test", "fixtures", "jev-cache.json");
const cache = await FileJudgeCache.load(cacheFile);
const client = new TypeSafeClient({ timeout: 120_000, logLevel: "warn" });

const configurations = [
  { name: "default", fallow: {}, repeat: 1 },
  { name: "fallow-min-tokens-20", fallow: { minTokens: 20 }, repeat: 1 },
  { name: "repeat-3", fallow: {}, repeat: 3 },
];
for (const configuration of configurations) {
  const report = await analyzeWithJev(client, {
    detect: {
      similarityTs: { paths: ["."], cwd: project, modes: ["functions", "types", "classes"] },
      fallow: configuration.fallow,
    },
    cache,
    repeat: configuration.repeat,
  });
  console.log(
    `\n### ${configuration.name}: ${report.stats.requests} new request(s), ${report.stats.cacheHits} cached\n`,
  );
  console.log(formatPrettyReport(report, project, { includeRejected: true }));
}
const saved = await cache.save(cacheFile);
console.log(`\n${saved ? "recorded" : "unchanged"}: ${cacheFile} (${cache.size} requests)`);
