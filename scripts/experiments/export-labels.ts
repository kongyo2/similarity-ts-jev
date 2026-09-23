import fs from "node:fs";
import path from "node:path";
import { pairKey } from "../../src/calibrate.ts";
import { CORPORA, corporaRoot, flag, loadCorpora, resultsRoot } from "./lib.ts";
import type { Label } from "./lib.ts";

const argv = process.argv.slice(2);
const labelsFile = flag(argv, "labels") ?? path.join(resultsRoot(), "labels", "labels.json");
const outDir = flag(argv, "out") ?? path.join(resultsRoot(), "labels", "cli");
const labels = JSON.parse(fs.readFileSync(labelsFile, "utf8")) as Record<string, Label>;
const corpora = await loadCorpora(["all"]);
fs.mkdirSync(outDir, { recursive: true });

for (const corpus of corpora) {
  const spec = CORPORA[corpus.name]!;
  const cwd = path.join(corporaRoot(), spec.dir);
  const byIndex = new Map(corpus.snippets.map((snippet) => [snippet.index, snippet]));
  const out: Record<string, Label> = {};
  let missing = 0;
  for (const [key, label] of Object.entries(labels)) {
    const [name, index] = key.split("#");
    if (name !== corpus.name) continue;
    const snippet = byIndex.get(Number(index));
    if (snippet === undefined) {
      missing += 1;
      continue;
    }
    out[pairKey(snippet.pair, cwd)] = {
      merge: label.merge,
      ...(label.shape !== undefined ? { shape: label.shape } : {}),
      ...(label.note !== undefined ? { note: label.note } : {}),
    };
  }
  const file = path.join(outDir, `${corpus.name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  const merges = Object.values(out).filter((label) => label.merge).length;
  console.log(
    `${file}: ${Object.keys(out).length} labels (${merges} merge, ${Object.keys(out).length - merges} keep)${missing > 0 ? `, ${missing} not in the snapshot` : ""}`,
  );
}
