import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { InternalServerError } from "@typesafe-ai/sdk";
import { runCli } from "../src/cli.ts";
import type { JsonReport } from "../src/format.ts";
import { FIXTURE_CACHE, FIXTURE_PROJECT, offline, stubClient } from "./helpers.ts";

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

const label = (p: { left: { symbolName: string }; right: { symbolName: string } }) => `${p.left.symbolName}<->${p.right.symbolName}`;

describe("similarity-ts-jev CLI (replayed)", () => {
  it("prints only the pairs Jev judged worth refactoring, as data", async () => {
    const { code, report, err } = await runJson([]);
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(err, [], "nothing on stderr on a clean run");
    assert.deepEqual(Object.keys(report).sort(), ["families", "results"], "no stats, counts, thresholds, or bookkeeping");
    const labels = report.results.map(label);
    assert.ok(labels.includes("cleanEscapedString<->cleanEscapedString"), labels.join(", "));
    assert.equal(labels.filter((l) => l === "withTempProject<->withTempProject").length, 3);
    assert.ok(!labels.includes("isFriday<->isMonday"), "documented public operations are left alone");
    assert.ok(!labels.includes("FPArity<->Quarter"), "unrelated concepts that share a shape are left alone");
    for (const p of report.results) {
      assert.ok(p.score >= 1.9);
      assert.deepEqual(Object.keys(p).filter((k) => k !== "instances").sort(), ["confidence", "left", "mode", "right", "sameConcept", "sameLogic", "score", "similarity"]);
    }
    const [best] = report.results;
    assert.equal(label(best!), "cleanEscapedString<->cleanEscapedString");
    const fragments = report.results.filter((p) => p.mode === "overlap");
    assert.ok(fragments.length >= 2, "clone groups are judged like any other pair");
    assert.ok(fragments.every((p) => p.left.kind === "fragment"));
    const family = report.families.find((f) => f.members.length === 3);
    assert.ok(family, "the three withTempProject copies are one family");
    assert.deepEqual(Object.keys(family).sort(), ["members", "score"]);
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

  it("adds the rejected pairs with --all and applies --min-score", async () => {
    const all = await runJson(["--all"]);
    assert.deepEqual(Object.keys(all.report).sort(), ["families", "rejected", "results"]);
    assert.ok(all.report.rejected!.some((p) => label(p) === "isFriday<->isMonday"));
    assert.ok(all.report.rejected!.every((p) => p.score < 1.9));
    const strict = await runJson(["--min-score", "2.9"]);
    assert.deepEqual(strict.report.results.map(label), ["cleanEscapedString<->cleanEscapedString"]);
    const friday = all.report.rejected!.find((p) => label(p) === "isFriday<->isMonday")!;
    const loose = await runJson(["--min-score", (friday.score - 0.01).toFixed(2)]);
    assert.ok(loose.report.results.map(label).includes("isFriday<->isMonday"), "a lower threshold lets it through");
  });

  it("reports a pair only once when both detectors find it", async () => {
    const { report } = await runJson(["--fallow-min-tokens", "20"]);
    const clean = report.results.filter((p) => label(p) === "cleanEscapedString<->cleanEscapedString");
    assert.equal(clean.length, 1);
    assert.equal(clean[0]!.mode, "functions");
  });

  it("prints one entry per family and nothing else, and writes --output silently", async () => {
    const { io, out, err } = capture();
    const code = await runCli([".", "--cache", FIXTURE_CACHE], io, { client: offline, cwd: FIXTURE_PROJECT });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    const text = out.join("\n");
    const lines = text.split("\n");
    assert.match(lines[0]!, /^2\.\d\d  src\/text\/format\.ts:\d+-\d+ cleanEscapedString <-> src\/text\/lightFormat\.ts:\d+-\d+ cleanEscapedString$/);
    const family = lines.indexOf(lines.find((l) => /^2\.\d\d$/.test(l))!);
    assert.ok(family > 0, "a family of three is a score line followed by its members");
    assert.equal(lines[family + 1], "      tests/analyze.test.ts:5-16 withTempProject");
    assert.equal(lines[family + 2], "      tests/cli.test.ts:5-16 withTempProject");
    assert.equal(lines[family + 3], "      tests/files.test.ts:5-16 withTempProject");
    assert.ok(lines.every((l) => /^(\d\.\d\d(  \S.*)?|      \S.*)$/.test(l)), `only scores and locations:\n${text}`);
    assert.doesNotMatch(text, /isFriday|Total|score|merge|worth|judged|Files|Pairs|Elapsed|===/);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "similarity-ts-jev-"));
    try {
      const written = capture();
      const file = path.join(dir, "nested", "report.txt");
      assert.equal(await runCli([".", "--cache", FIXTURE_CACHE, "--output", file], written.io, { client: offline, cwd: FIXTURE_PROJECT }), 0);
      assert.deepEqual(written.out, [], "nothing on stdout when writing a file");
      assert.equal(await fs.readFile(file, "utf8"), `${text}\n`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  it("counts without asking Jev in --dry-run", async () => {
    const { io, out } = capture();
    const code = await runCli([".", "--dry-run"], io, { client: offline, cwd: FIXTURE_PROJECT });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /^12 pairs, 1 requests, \d+ tokens$/);
  });

  it("exits 2 and lists the pairs it could not judge when Jev fails", async () => {
    const failing = stubClient(() => {
      throw new InternalServerError(503, { error: "overloaded" }, new Headers());
    });
    const { io, out, err } = capture();
    const code = await runCli([".", "--format", "json"], io, { client: failing, cwd: FIXTURE_PROJECT });
    assert.equal(code, 2);
    const report = JSON.parse(out.join("\n")) as JsonReport;
    assert.deepEqual(report.results, []);
    assert.equal(report.unjudged!.length, 12);
    assert.match(report.unjudged![0]!.error, /503 overloaded/);
    assert.match(err.join("\n"), /12 pairs not judged: InternalServerError: 503 overloaded/);
  });

  it("rejects bad options and unknown modes", async () => {
    const { io, err } = capture();
    assert.equal(await runCli([".", "--modes", "functions,bogus"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.match(err.join("\n"), /unknown mode "bogus"/);
    assert.equal(await runCli([".", "--min-score", "9"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.equal(await runCli([".", "--same-file-only", "--cross-file-only"], io, { client: offline, cwd: FIXTURE_PROJECT }), 1);
    assert.equal(await runCli(["--help"], io), 0);
  });
});
