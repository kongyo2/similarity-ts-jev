import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterClient } from "./adapter.ts";
import { FileJudgeCache } from "../src/cache.ts";
import { analyzeWithJev } from "../src/index.ts";
import { formatPrettyReport } from "../src/format.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "test", "fixtures", "project");
const cacheFile = path.join(root, "test", "fixtures", "jev-cache.json");
const cache = await FileJudgeCache.load(cacheFile);
const client = await createAdapterClient();

const configurations = [
  { name: "default", fallow: {} },
  { name: "fallow-min-tokens-20", fallow: { minTokens: 20 } },
];
for (const configuration of configurations) {
  const report = await analyzeWithJev(client, {
    detect: { similarityTs: { paths: ["."], cwd: project, modes: ["functions", "types", "classes"] }, fallow: configuration.fallow },
    cache,
    includeRejected: true,
  });
  console.log(`\n### ${configuration.name}: ${report.stats.requests} new request(s), ${report.stats.cacheHits} cached\n`);
  console.log(formatPrettyReport(report, project));
}
const saved = await cache.save(cacheFile);
console.log(`\n${saved ? "recorded" : "unchanged"}: ${cacheFile} (${cache.size} requests)`);
