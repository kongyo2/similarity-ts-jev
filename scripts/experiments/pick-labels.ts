import fs from "node:fs";
import path from "node:path";
import { CORPORA, flag, loadCorpora, mulberry32, numberFlag, readLines, resultsRoot } from "./lib.ts";
import type { Read } from "./questions-v2.ts";

interface Result {
  corpus: string;
  key: string;
  index: number;
  answers: Read;
  error?: string;
}

const argv = process.argv.slice(2);
const arm = flag(argv, "arm") ?? "all-r1";
const perBin = numberFlag(argv, "per-bin", 20);
const seed = numberFlag(argv, "seed", 7);
const clip = numberFlag(argv, "clip", 1400);
const outDir = flag(argv, "out") ?? path.join(resultsRoot(), "labels");

const results = readLines<Result>(path.join(resultsRoot(), "solo", `${arm}.jsonl`)).filter(
  (r) => r.error === undefined && r.answers.refactor !== undefined,
);
const corpora = await loadCorpora(Object.keys(CORPORA));
const snippets = new Map<string, { corpus: string; snippet: (typeof corpora)[number]["snippets"][number] }>(
  corpora.flatMap((c) => c.snippets.map((s) => [`${c.name}#${s.index}`, { corpus: c.name, snippet: s }] as const)),
);

const bins = [0, 0.5, 1, 1.5, 2, 2.5, 3.01];
const random = mulberry32(seed);
const chosen: Result[] = [];
for (let b = 0; b < bins.length - 1; b += 1) {
  const inBin = results.filter(
    (r) => r.answers.refactor!.score >= bins[b]! && r.answers.refactor!.score < bins[b + 1]!,
  );
  const byCorpus = new Map<string, Result[]>();
  for (const r of inBin) byCorpus.set(r.corpus, [...(byCorpus.get(r.corpus) ?? []), r]);
  for (const list of byCorpus.values()) list.sort(() => random() - 0.5);
  const names = [...byCorpus.keys()];
  if (names.length === 0) continue;
  let picked = 0;
  let guard = 0;
  while (picked < perBin && guard < perBin * 10) {
    guard += 1;
    const name = names[guard % names.length]!;
    const next = byCorpus.get(name)!.pop();
    if (next === undefined) continue;
    chosen.push(next);
    picked += 1;
  }
}

const order = [...chosen].sort(() => random() - 0.5);
const lines: string[] = [
  "# Pairs to label",
  "",
  "Label each pair as `merge` (a careful reviewer would ask for one shared implementation, or insist) or `keep` (would let it pass, or would not ask), and for a merge which shape: remove_copy, derive, extract_shared.",
  "",
];
const template: Record<string, { merge: null; shape: null; note: string }> = {};
const hidden: Record<string, number> = {};
const cut = (text: string): string =>
  text.length > clip ? `${text.slice(0, clip)}\n/* … ${text.length - clip} more characters … */` : text;
for (const [n, r] of order.entries()) {
  const entry = snippets.get(r.key);
  if (entry === undefined) continue;
  const s = entry.snippet;
  hidden[r.key] = r.answers.refactor!.score;
  template[r.key] = { merge: null, shape: null, note: "" };
  lines.push(
    `## ${n + 1}. ${r.key}  (${entry.corpus}, ${s.pair.mode}${s.alsoAt !== undefined ? `, also at ${s.alsoAt.join(", ")}` : ""})`,
    "",
  );
  for (const [side, snippet] of [
    ["a", s.a],
    ["b", s.b],
  ] as const) {
    lines.push(`### ${side}: ${snippet.path}:${snippet.lines} ${snippet.kind} ${snippet.name}`, "");
    if (snippet.doc !== undefined) lines.push("```", cut(snippet.doc), "```", "");
    lines.push("```ts", cut(snippet.code), "```", "");
  }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "todo.md"), lines.join("\n"));
fs.writeFileSync(path.join(outDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "hidden-scores.json"), `${JSON.stringify(hidden, null, 2)}\n`);
process.stdout.write(`${order.length} pairs written to ${outDir}/todo.md (${lines.join("\n").length} chars)\n`);
