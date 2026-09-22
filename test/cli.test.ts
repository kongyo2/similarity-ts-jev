import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { InternalServerError } from "@typesafe-ai/sdk";
import { CACHE_VERSION } from "../src/cache.ts";
import type { CacheFile } from "../src/cache.ts";
import type { Calibration } from "../src/calibrate.ts";
import { exitCode, runCli } from "../src/cli.ts";
import type { JsonReport } from "../src/format.ts";
import type { JevReport } from "../src/types.ts";
import { FIXTURE_CACHE, FIXTURE_MODEL, FIXTURE_PROJECT, answerAll, offline, stubClient } from "./helpers.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) }, out, err };
}

async function runJson(args: string[]) {
  const { io, out, err } = capture();
  const code = await runCli([".", "--format", "json", "--cache", FIXTURE_CACHE, ...args], io, { client: offline, cwd: FIXTURE_PROJECT });
  const report = JSON.parse(out.join("\n")) as JsonReport;
  return { code, report, err, out };
}

async function runPretty(args: string[]) {
  const { io, out, err } = capture();
  const code = await runCli([".", "--cache", FIXTURE_CACHE, ...args], io, { client: offline, cwd: FIXTURE_PROJECT });
  return { code, text: out.join("\n"), lines: out.join("\n").split("\n"), err };
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "similarity-ts-jev-"));
  try {
    return await work(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const label = (p: { left: { symbolName: string }; right: { symbolName: string } }) => `${p.left.symbolName}<->${p.right.symbolName}`;

const PAIR_KEYS = ["borderline", "confidence", "left", "mode", "right", "sameConcept", "sameLogic", "score", "shape", "shapeConfidence", "similarity", "unsure"];
const FAMILY_KEYS = ["borderline", "members", "score", "shape", "unsure"];

describe("similarity-ts-jev CLI (replayed)", () => {
  it("prints only the pairs Jev judged worth refactoring, as data, with the change a reviewer would ask for", async () => {
    const { code, report, err } = await runJson([]);
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(err, [], "nothing on stderr on a clean run");
    assert.deepEqual(Object.keys(report).sort(), ["families", "results"], "no stats, counts, thresholds, or bookkeeping unless asked");
    const labels = report.results.map(label);
    assert.ok(labels.includes("cleanEscapedString<->cleanEscapedString"), labels.join(", "));
    assert.equal(labels.filter((l) => l === "withTempProject<->withTempProject").length, 3);
    assert.ok(!labels.includes("isFriday<->isMonday"), "documented public operations are left alone");
    assert.ok(!labels.includes("FPArity<->Quarter"), "unrelated concepts that share a shape are left alone");
    assert.ok(!labels.includes("analyzeTest<->cliTest"), "tests that only share a setup are left alone");
    for (const p of report.results) {
      assert.ok(p.score >= 1.9);
      assert.deepEqual(Object.keys(p).filter((k) => k !== "instances").sort(), PAIR_KEYS);
      assert.ok(!("unstable" in p) && !("passes" in p), "single-pass runs say nothing about passes");
    }
    const [best] = report.results;
    assert.equal(label(best!), "cleanEscapedString<->cleanEscapedString");
    assert.equal(best!.shape, "remove_copy");
    assert.ok(best!.shapeConfidence > 0.5);
    assert.deepEqual([best!.unsure, best!.borderline], [false, false]);
    const weekStartsOn = report.results.find((p) => label(p) === "weekStartsOn<->weekStartsOn")!;
    assert.equal(weekStartsOn.shape, "extract_shared", "a shared helper with two copies is extracted, not deleted");
    assert.equal(weekStartsOn.unsure, true, "reported although Jev's confidence is under 0.5");
    const part = report.results.find((p) => label(p) === "part<->part")!;
    assert.equal(part.borderline, true, "within 0.25 of the cutoff");
    assert.equal(part.unsure, false);
    assert.ok(report.results.every((p, i, all) => i === 0 || all[i - 1]!.score >= p.score), "best first");
    const family = report.families.find((f) => f.members.length === 3);
    assert.ok(family, "the three withTempProject copies are one family");
    assert.deepEqual(Object.keys(family).sort(), FAMILY_KEYS);
    assert.equal(family.shape, "remove_copy");
    assert.deepEqual([family.unsure, family.borderline], [false, false]);
    assert.ok(report.families.every((f, i, all) => i === 0 || all[i - 1]!.score >= f.score), "best first");
  });

  it("never says which detector reported a pair", async () => {
    const { io, out } = capture();
    for (const format of ["json", "pretty"]) {
      out.length = 0;
      await runCli([".", "--format", format, "--cache", FIXTURE_CACHE, "--all", "--fallow-min-tokens", "20"], io, { client: offline, cwd: FIXTURE_PROJECT });
      const text = out.join("\n");
      const withoutPaths = text.split(FIXTURE_PROJECT).join("").split(FIXTURE_PROJECT.replaceAll("\\", "\\\\")).join("");
      assert.doesNotMatch(withoutPaths, /similarity-ts|fallow|detectedBy|detectors|fingerprint|clone|\bvia\b/i, `${format} output names a detector`);
    }
  });

  it("adds the rejected pairs with --all and applies the thresholds", async () => {
    const all = await runJson(["--all"]);
    assert.deepEqual(Object.keys(all.report).sort(), ["families", "rejected", "results"]);
    const friday = all.report.rejected!.find((p) => label(p) === "isFriday<->isMonday")!;
    assert.ok(friday, "the rejected list is complete");
    assert.equal(friday.borderline, true, "close to the cutoff from below");
    assert.equal(friday.unsure, false, "only reported pairs are unsure");
    assert.ok(all.report.rejected!.every((p) => p.score < 1.9));
    assert.deepEqual(Object.keys(friday).sort(), PAIR_KEYS);
    const strict = await runJson(["--min-score", "2.9"]);
    assert.deepEqual(strict.report.results.map(label), ["cleanEscapedString<->cleanEscapedString"]);
    const loose = await runJson(["--min-score", (friday.score - 0.01).toFixed(2)]);
    assert.ok(loose.report.results.map(label).includes("isFriday<->isMonday"), "a lower threshold lets it through");
    const sure = await runJson(["--unsure-below", "0.9"]);
    assert.deepEqual(sure.report.results.filter((p) => !p.unsure).map(label), ["cleanEscapedString<->cleanEscapedString"]);
    const narrow = await runJson(["--margin", "0", "--all"]);
    assert.ok([...narrow.report.results, ...narrow.report.rejected!].every((p) => !p.borderline));
    const wide = await runJson(["--margin", "0.5", "--all"]);
    assert.ok(wide.report.results.some((p) => label(p) === "weekStartsOn<->weekStartsOn" && p.borderline));
  });

  it("reports a pair only once when both detectors find it", async () => {
    const { report } = await runJson(["--fallow-min-tokens", "20"]);
    const clean = report.results.filter((p) => label(p) === "cleanEscapedString<->cleanEscapedString");
    assert.equal(clean.length, 1);
    assert.equal(clean[0]!.mode, "functions");
    const { report: all } = await runJson(["--fallow-min-tokens", "20", "--all"]);
    const fragments = all.rejected!.filter((p) => p.mode === "overlap");
    assert.ok(fragments.length >= 1, "clone groups are judged like any other pair");
    assert.ok(fragments.every((p) => p.left.kind === "fragment"));
  });

  it("prints one line per family with the score, a flag, and the shape, and writes --output silently", async () => {
    const { code, text, lines, err } = await runPretty([]);
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.match(lines[0]!, /^2\.\d\d  copy     src\/text\/format\.ts:27-35 cleanEscapedString <-> src\/text\/lightFormat\.ts:17-25 cleanEscapedString$/);
    const family = lines.findIndex((l) => /^2\.\d\d  copy$/.test(l));
    assert.ok(family > 0, "a family of three is a score line followed by its members");
    assert.equal(lines[family + 1], "      tests/analyze.test.ts:5-16 withTempProject");
    assert.equal(lines[family + 2], "      tests/cli.test.ts:5-16 withTempProject");
    assert.equal(lines[family + 3], "      tests/files.test.ts:5-16 withTempProject");
    assert.match(text, /^2\.\d\d\? extract  src\/text\/format\.ts:6-12 weekStartsOn <-> src\/text\/parse\.ts:2-8 weekStartsOn$/m, "unsure pairs carry ?");
    assert.match(text, /^1\.9\d~ extract  src\/text\/format\.ts:12-17 part <-> src\/text\/lightFormat\.ts:6-11 part$/m, "borderline pairs carry ~");
    assert.ok(lines.every((l) => /^(\d\.\d\d[ ?~!] (copy|derive|extract)( +\S.*)?|      \S.*)$/.test(l)), `only scores, flags, shapes, and locations:\n${text}`);
    assert.doesNotMatch(text, /isFriday|Total|score|merge|worth|judged|Files|Pairs|Elapsed|===/);

    const all = await runPretty(["--all"]);
    const blank = all.lines.indexOf("");
    assert.ok(blank > 0, "the rejected pairs follow after a blank line");
    assert.match(all.lines[blank + 1]!, /^1\.\d\d~ -        src\/api\/isFriday\.ts:1-4 isFriday <-> src\/api\/isMonday\.ts:1-4 isMonday$/, "rejected pairs have no shape and keep their flag");
    assert.ok(all.lines.slice(blank + 1).every((l) => /^\d\.\d\d[ ?~!] -        \S/.test(l)));

    await withTempDir(async (dir) => {
      const written = capture();
      const file = path.join(dir, "nested", "report.txt");
      assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--output", file], written.io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
      assert.deepEqual(written.out, [], "nothing on stdout when writing a file");
      assert.equal(await fs.readFile(file, "utf8"), `${text}\n`);
    });
  });

  it("prints nothing when no pair is worth refactoring", async () => {
    const { io, out, err } = capture();
    assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--min-score", "3"], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
    assert.deepEqual(out, []);
    assert.deepEqual(err, []);
    const { report } = await runJson(["--min-score", "3"]);
    assert.deepEqual(report, { results: [], families: [] });
  });

  it("exits 1 with --fail-on-duplicates when something is worth refactoring", async () => {
    const { io } = capture();
    assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--fail-on-duplicates"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--fail-on-duplicates", "--min-score", "3"], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
  });

  it("asks every pair again with --repeat, decides on the mean, and shows the passes", async () => {
    const { code, report, err } = await runJson(["--repeat", "3", "--stats"]);
    assert.equal(code, 0, err.join("\n"));
    assert.equal(report.stats!.passes, 3);
    assert.equal(report.stats!.cacheHits, 3, "one cached request per pass");
    assert.equal(report.stats!.requests, 0);
    for (const p of report.results) {
      assert.equal(p.passes!.count, 3);
      assert.equal(p.passes!.scores.length, 3);
      assert.ok(Math.abs(p.passes!.scores.reduce((sum, s) => sum + s, 0) / 3 - p.score) < 5e-5, "the score is the mean of the passes");
      assert.equal(p.passes!.spread, Math.round((Math.max(...p.passes!.scores) - Math.min(...p.passes!.scores)) * 1000) / 1000);
      assert.equal(p.unstable, p.passes!.scores.some((s) => s >= 1.9) && p.passes!.scores.some((s) => s < 1.9));
      assert.equal(Number(p.score.toFixed(4)), p.score, "means are rounded");
    }
    assert.ok(report.families.every((f) => "unstable" in f));
    const single = await runJson(["--stats"]);
    assert.equal(single.report.stats!.passes, 1);
    assert.equal(single.report.stats!.cacheHits, 1);
    assert.ok(single.report.results.every((p) => !("passes" in p)));
    const pretty = await runPretty(["--repeat", "3"]);
    assert.match(pretty.lines[0]!, /^2\.9\d  copy     src\/text\/format\.ts:27-35 cleanEscapedString/);
    assert.ok(pretty.lines.every((l) => /^(\d\.\d\d[ ?~!] (copy|derive|extract)( +\S.*)?|      \S.*)$/.test(l)));
  });

  it("prints the spend with --stats, on stderr for pretty and in the document for json", async () => {
    const pretty = await runPretty(["--stats"]);
    assert.equal(pretty.err.length, 1);
    assert.match(pretty.err[0]!, /^6 worth refactoring, 6 left as they are; 12 pairs from 10 files; 0 requests, 1 answered from the cache; 0 input tokens \(~\$0\.0000\); \d+\.\ds; thresholds: min-score 1\.90, unsure-below 0\.50, margin 0\.25$/);
    assert.ok(!pretty.text.includes("worth refactoring"), "the summary stays out of the report");
    const repeated = await runPretty(["--stats", "--repeat", "3", "--min-score", "2"]);
    assert.match(repeated.err[0]!, /^5 worth refactoring, 7 left as they are; 12 pairs from 10 files; 0 requests, 3 answered from the cache, 3 passes;.*min-score 2\.00/);
    const json = await runJson(["--stats", "--all"]);
    assert.deepEqual(Object.keys(json.report).sort(), ["families", "rejected", "results", "stats", "thresholds"]);
    assert.deepEqual(json.report.thresholds, { minScore: 1.9, unsureBelow: 0.5, margin: 0.25 });
    assert.deepEqual(Object.keys(json.report.stats!).sort(), ["cacheHits", "elapsedMs", "fileCount", "inputTokens", "judged", "outputTokens", "pairCount", "passes", "rateLimited", "requests", "retries", "splits", "unjudged", "usd"]);
    assert.equal(json.report.stats!.judged, 12);
    assert.equal(json.report.stats!.usd, 0);
  });

  it("records a run and replays it under other thresholds without detection or requests", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "runs", "run.json");
      const recorded = await runJson(["--all", "--record", file]);
      assert.equal(recorded.code, 0, recorded.err.join("\n"));
      const record = JSON.parse(await fs.readFile(file, "utf8")) as { schema: string; cwd: string; pairs: unknown[]; thresholds: { minScore: number } };
      assert.equal(record.schema, "similarity-ts-jev/run/1");
      assert.equal(record.cwd, FIXTURE_PROJECT);
      assert.equal(record.pairs.length, 12, "rejected pairs are recorded too");
      assert.equal(record.thresholds.minScore, 1.9);

      const elsewhere = path.join(dir, "elsewhere");
      await fs.mkdir(elsewhere);
      const replayed = capture();
      const code = await runCli(["--replay", file, "--format", "json", "--all"], replayed.io, { client: offline, cwd: elsewhere });
      assert.equal(code, 0, replayed.err.join("\n"));
      assert.deepEqual(JSON.parse(replayed.out.join("\n")), recorded.report, "the same thresholds give the same document");

      const strict = capture();
      assert.equal(await runCli(["--replay", file, "--format", "json", "--min-score", "2.9", "--stats"], strict.io, { cwd: elsewhere }), 0);
      const strictReport = JSON.parse(strict.out.join("\n")) as JsonReport;
      assert.deepEqual(strictReport.results.map(label), ["cleanEscapedString<->cleanEscapedString"]);
      assert.equal(strictReport.families.length, 1);
      assert.deepEqual(strictReport.thresholds, { minScore: 2.9, unsureBelow: 0.5, margin: 0.25 });
      assert.equal(strictReport.stats!.requests, 0, "the recorded run was replayed from the cache");
      assert.equal(strictReport.stats!.cacheHits, 1, "the recorded run's counts are kept");
      assert.equal(strictReport.stats!.passes, 1);

      const pretty = capture();
      assert.equal(await runCli(["--replay", file, "--min-score", "1.5", "--fail-on-duplicates"], pretty.io, { cwd: elsewhere }), 1, "the gate applies to the replayed decisions");
      const lines = pretty.out.join("\n").split("\n");
      assert.match(lines[0]!, /^2\.\d\d  copy     src\/text\/format\.ts:27-35 cleanEscapedString/, "paths stay relative to the recorded project");
      assert.ok(lines.some((l) => /isFriday/.test(l)), "a lower cutoff reports more");

      const other = path.join(dir, "cache.json");
      await fs.writeFile(other, JSON.stringify({ version: CACHE_VERSION, entries: {} }));
      const refused = capture();
      assert.equal(await runCli(["--replay", other], refused.io, { cwd: elsewhere }), 1);
      assert.match(refused.err.join("\n"), /not a similarity-ts-jev run record/);

      const tuned = path.join(dir, "tuned.json");
      assert.equal((await runJson(["--min-score", "2.5", "--margin", "0.1", "--record", tuned])).code, 0);
      const asRecorded = capture();
      assert.equal(await runCli(["--replay", tuned, "--format", "json", "--stats"], asRecorded.io, { cwd: elsewhere }), 0);
      const asRecordedReport = JSON.parse(asRecorded.out.join("\n")) as JsonReport;
      assert.deepEqual(asRecordedReport.thresholds, { minScore: 2.5, unsureBelow: 0.5, margin: 0.1 }, "a replay without threshold flags keeps the recorded thresholds");
      assert.ok(asRecordedReport.results.length > 0 && asRecordedReport.results.every((p) => p.score >= 2.5));
      const overridden = capture();
      assert.equal(await runCli(["--replay", tuned, "--format", "json", "--stats", "--min-score", "1.9"], overridden.io, { cwd: elsewhere }), 0);
      assert.deepEqual((JSON.parse(overridden.out.join("\n")) as JsonReport).thresholds, { minScore: 1.9, unsureBelow: 0.5, margin: 0.1 }, "a flag given on the command line wins");
    });
  });

  it("describes the score distribution with --calibrate, and the accuracy against --labels", async () => {
    const { code, text, lines } = await runPretty(["--calibrate"]);
    assert.equal(code, 0);
    assert.equal(lines[0], "12 judged pairs; 6 at or over 1.90, 2 within 0.25 of it, 1 reported with confidence under 0.50");
    assert.equal(lines.filter((l) => /^  \d\.\d\d-\d\.\d\d /.test(l)).length, 12, "a histogram of twelve bins");
    assert.match(text, /^widest gap \d\.\d\d between \d\.\d\d and \d\.\d\d: /m);
    assert.match(text, /^headroom: highest score under the cutoff 1\.8\d, lowest at or over it 1\.9\d; confidence median \d\.\d\d \(p10 \d\.\d\d, p90 \d\.\d\d\)$/m);
    assert.doesNotMatch(text, /labels:|passes:/);
    const repeated = await runPretty(["--calibrate", "--repeat", "3"]);
    assert.match(repeated.text, /^3 passes: mean spread \d\.\d\d, p90 \d\.\d\d; \d+ pairs crossed the cutoff between passes$/m);
    const withStats = await runPretty(["--calibrate", "--stats"]);
    assert.equal(withStats.err.length, 1);
    assert.match(withStats.err[0]!, /^6 worth refactoring, 6 left as they are; 12 pairs from 10 files; 0 requests, 1 answered from the cache; /);
    const jsonWithStats = capture();
    assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--calibrate", "--stats", "--format", "json"], jsonWithStats.io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
    const document = JSON.parse(jsonWithStats.out.join("\n")) as { calibration: Calibration; thresholds: unknown; stats: { judged: number } };
    assert.deepEqual(Object.keys(document).sort(), ["calibration", "stats", "thresholds"]);
    assert.equal(document.stats.judged, 12);

    await withTempDir(async (dir) => {
      const file = path.join(dir, "labels.json");
      await fs.writeFile(
        file,
        JSON.stringify({
          "src/text/format.ts:27:cleanEscapedString <-> src/text/lightFormat.ts:17:cleanEscapedString": true,
          "tests/cli.test.ts:5:withTempProject <-> tests/analyze.test.ts:5:withTempProject": { merge: true },
          "src/text/parse.ts:2:weekStartsOn <-> src/text/format.ts:6:weekStartsOn": true,
          "src/text/format.ts:12:part <-> src/text/lightFormat.ts:6:part": false,
          "src/api/isFriday.ts:1:isFriday <-> src/api/isMonday.ts:1:isMonday": false,
          "src/types/arity.ts:1:FPArity <-> src/types/quarter.ts:1:Quarter": { merge: false },
          "src/nowhere.ts:1:x <-> src/nowhere.ts:9:y": true,
        }),
      );
      const labeled = await runPretty(["--calibrate", "--labels", file]);
      assert.equal(labeled.code, 0, labeled.err.join("\n"));
      assert.match(labeled.text, /^labels: 6 labeled pairs found \(3 merge, 3 keep\), 1 labels matched no pair$/m);
      assert.match(labeled.text, /^  at 1\.90: precision 0\.75, recall 1\.00, accuracy 0\.83 \(tp 3, fp 1, fn 0, tn 2\)$/m);
      assert.match(labeled.text, /^  score {8}AUC \d\.\d\d; fitted cutoff \d\.\d\d \((not )?separable: lowest merge \d\.\d\d, highest keep \d\.\d\d\); at the fit precision \d\.\d\d recall \d\.\d\d; \d-fold hold-out accuracy \d\.\d\d/m);
      assert.match(labeled.text, /^  unsure band \(confidence < 0\.50\): 1 of 4 reported; precision 1\.00 there, 0\.67 for the rest$/m);
      assert.match(labeled.text, /^  wrong: 1\.9\d \(confidence \d\.\d\d, logic \d\.\d\d, concept \d\.\d\d\) labeled keep  src\/text\/format\.ts:12:part <-> src\/text\/lightFormat\.ts:6:part$/m);

      const { io, out } = capture();
      assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--calibrate", "--labels", file, "--format", "json"], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
      const { calibration } = JSON.parse(out.join("\n")) as { calibration: Calibration };
      assert.equal(calibration.judged, 12);
      assert.deepEqual(calibration.labels?.atCutoff, { cutoff: 1.9, tp: 3, fp: 1, fn: 0, tn: 2, precision: 0.75, recall: 1, accuracy: 5 / 6 });
      assert.equal(calibration.labels?.unmatched, 1);

      const bad = path.join(dir, "bad.json");
      await fs.writeFile(bad, JSON.stringify({ "a <-> b": "yes" }));
      const refused = capture();
      assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--calibrate", "--labels", bad], refused.io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
      assert.match(refused.err.join("\n"), /label for "a <-> b" must be true, false, or \{ "merge": boolean \}/);
    });
  });

  it("sends --conventions with every request and asks again when they change", async () => {
    const states: Record<string, unknown>[] = [];
    const client = stubClient((request) => {
      states.push(request.state as Record<string, unknown>);
      return answerAll(request);
    });
    const { io, out, err } = capture();
    const code = await runCli([".", "--conventions", "Locale files stay separate on purpose.", "--format", "json", "--stats"], io, { client, cwd: FIXTURE_PROJECT });
    assert.equal(code, 0, err.join("\n"));
    assert.equal(states.length, 1, "one request for the whole project");
    assert.equal(states[0]!.repository_conventions, "Locale files stay separate on purpose.");
    assert.equal(states[0]!.repository, "project");
    assert.equal(typeof states[0]!.task, "string");
    const report = JSON.parse(out.join("\n")) as JsonReport;
    assert.deepEqual(report.results, [], "the stub leaves everything as it is");
    assert.equal(report.stats!.requests, 1);
    assert.equal(report.stats!.inputTokens, 100);
    const plain = capture();
    assert.equal(await runCli([".", "--format", "json"], plain.io, { client, cwd: FIXTURE_PROJECT }), 0);
    assert.equal(states.length, 2);
    assert.ok(!("repository_conventions" in states[1]!), "no conventions unless given");
  });

  it("counts without asking Jev in --dry-run, honoring --max-pairs, --repeat, --pairs-per-request, and the warning gate", async () => {
    const { io, out, err } = capture();
    assert.equal(await runCli([".", "--dry-run"], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
    assert.match(out.join("\n"), /^12 pairs, 1 requests, \d+ tokens, ~\$0\.\d{4}$/);
    const plainTokens = Number(/(\d+) tokens/.exec(out.join("\n"))![1]);
    out.length = 0;
    assert.equal(await runCli([".", "--dry-run", "--max-pairs", "3"], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
    assert.match(out.join("\n"), /^3 pairs, 1 requests, \d+ tokens, ~\$0\.\d{4}$/);
    out.length = 0;
    assert.equal(await runCli([".", "--dry-run", "--repeat", "3", "--conventions", "Locale files stay separate."], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
    assert.match(out.join("\n"), /^12 pairs, 3 requests, \d+ tokens, ~\$0\.\d{4} \(3 passes\)$/);
    const repeatedTokens = Number(/(\d+) tokens/.exec(out.join("\n"))![1]);
    assert.ok(repeatedTokens > plainTokens * 3, "three passes cost three times, plus the conventions in every state");
    out.length = 0;
    assert.equal(await runCli([".", "--dry-run", "--pairs-per-request", "5"], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
    assert.match(out.join("\n"), /^12 pairs, 3 requests, /);
    out.length = 0;
    assert.equal(await runCli(["src", "missing-dir", "--dry-run"], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
    assert.match(err.join("\n"), /missing-dir/);
    assert.equal(await runCli(["src", "missing-dir", "--dry-run", "--fail-on-warnings"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    out.length = 0;
    assert.equal(await runCli([".", "--dry-run", "--same-file-only"], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
    assert.match(out.join("\n"), /^0 pairs, 0 requests, 0 tokens, ~\$0\.0000$/, "every duplicate in the fixture spans two files");
  });

  it("drops a cache written by an older version and records the fresh answers", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "cache.json");
      await fs.writeFile(file, JSON.stringify({ version: 1, entries: { stale: { request: {}, response: {} } } }));
      const client = stubClient((request) => answerAll(request), "req_fresh", FIXTURE_MODEL);
      const { io, err } = capture();
      assert.equal(await runCli([".", "--cache", file], io, { client, cwd: FIXTURE_PROJECT }), 0);
      assert.match(err.join("\n"), /1 entries from an older version were dropped/);
      assert.equal(client.calls, 1);
      const written = JSON.parse(await fs.readFile(file, "utf8")) as CacheFile;
      assert.equal(written.version, CACHE_VERSION);
      assert.equal(Object.keys(written.entries).length, 1);
      const again = capture();
      assert.equal(await runCli([".", "--cache", file], again.io, { client, cwd: FIXTURE_PROJECT }), 0);
      assert.equal(client.calls, 1, "the second run replays");
      assert.deepEqual(again.err, []);
    });
  });

  it("writes an empty file for an empty report", async () => {
    await withTempDir(async (dir) => {
      const { io } = capture();
      const file = path.join(dir, "empty.txt");
      assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--min-score", "3", "--output", file], io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
      assert.equal((await fs.stat(file)).size, 0);
    });
  });

  it("maps analysis problems to 1 and judgment failures to 2", () => {
    const base = { analyzedFiles: [], skippedFiles: [], warnings: [], results: [], families: [], rejected: [], rejectedCount: 0, unjudged: [], thresholds: { minScore: 1.9 } } as unknown as JevReport;
    const pair = { mode: "functions", similarity: 1, left: { filePath: "a", startLine: 1, endLine: 1, symbolName: "a", kind: "function" }, right: { filePath: "b", startLine: 1, endLine: 1, symbolName: "b", kind: "function" } } as const;
    const stats = { fileCount: 1 } as JevReport["stats"];
    const gates = { failOnWarnings: false, failOnDuplicates: false };
    assert.equal(exitCode({ ...base, stats }, gates), 0);
    assert.equal(exitCode({ ...base, stats, unjudged: [{ ...pair, reason: "capped", error: "over the --max-pairs limit (1)" }] }, gates), 0);
    assert.equal(exitCode({ ...base, stats, unjudged: [{ ...pair, reason: "unreadable", error: "could not read the source: ENOENT" }] }, gates), 1);
    assert.equal(exitCode({ ...base, stats, unjudged: [{ ...pair, reason: "api", error: "InternalServerError: 503" }] }, gates), 2);
    assert.equal(exitCode({ ...base, stats, warnings: [{ message: "w" }] }, gates), 0);
    assert.equal(exitCode({ ...base, stats, warnings: [{ message: "w" }] }, { ...gates, failOnWarnings: true }), 1);
    assert.equal(exitCode({ ...base, stats: { fileCount: 0 } as JevReport["stats"], warnings: [{ message: "w" }] }, gates), 1);
  });

  it("exits 2 and lists the pairs it could not judge when Jev fails", async () => {
    const failing = stubClient(() => {
      throw new InternalServerError(503, { error: "overloaded" }, new Headers());
    });
    const { io, out, err } = capture();
    const code = await runCli([".", "--format", "json", "--retries", "0"], io, { client: failing, cwd: FIXTURE_PROJECT });
    assert.equal(code, 2);
    const report = JSON.parse(out.join("\n")) as JsonReport;
    assert.deepEqual(report.results, []);
    assert.equal(report.unjudged!.length, 12);
    assert.ok(report.unjudged!.every((p) => p.reason === "api"));
    assert.match(report.unjudged![0]!.error, /503 overloaded/);
    assert.match(err.join("\n"), /12 pairs not judged: InternalServerError: 503 overloaded/);
    assert.equal(failing.calls, 1, "no retries when asked for none");
  });

  it("rejects bad options, unknown modes, and a run with neither paths nor --replay", async () => {
    const { io, err, out } = capture();
    assert.equal(await runCli([".", "--modes", "functions,bogus"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.match(err.join("\n"), /unknown mode "bogus"/);
    assert.equal(await runCli([".", "--min-score", "9"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.equal(await runCli([".", "--unsure-below", "2"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.equal(await runCli([".", "--repeat", "0"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.equal(await runCli([".", "--budget-tokens", "10"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.equal(await runCli([".", "--same-file-only", "--cross-file-only"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    err.length = 0;
    assert.equal(await runCli([], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.match(err.join("\n"), /missing required argument 'paths' \(or pass --replay <file>\)/);
    assert.equal(await runCli(["--help"], io), 0);
    const help = err.join("\n") + out.join("\n");
    for (const flag of ["--base-url <url>", "--replay <file>", "--record <file>", "--conventions <text>", "--repeat <number>", "--calibrate", "--labels <file>", "--stats", "--unsure-below <number>", "--margin <number>"]) {
      assert.ok(help.includes(flag), `help lists ${flag}`);
    }
  });
});
