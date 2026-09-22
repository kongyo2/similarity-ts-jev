import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { detect, mergePairs } from "../src/detect.ts";
import { FallowError, runFallow } from "../src/fallow.ts";
import { groupFamilies } from "../src/families.ts";
import { toRelativePath } from "../src/snippets.ts";
import type { DetectedPair, JudgedPair } from "../src/types.ts";
import { FIXTURE_PROJECT, location, pair } from "./helpers.ts";

const rel = (p: { filePath: string }) => toRelativePath(p.filePath, FIXTURE_PROJECT);
const describePair = (p: DetectedPair) => `${rel(p.left)}:${p.left.symbolName}<->${rel(p.right)}:${p.right.symbolName}`;
const analyze = { paths: ["."], cwd: FIXTURE_PROJECT, modes: ["functions", "types", "classes"] as ("functions" | "types" | "classes")[] };

describe("detect: similarity-ts and fallow on the fixture project", () => {
  it("merges both detectors' reports into one list that does not say who found what", async () => {
    const report = await detect({ similarityTs: analyze });
    assert.equal(report.warnings.length, 0, JSON.stringify(report.warnings));
    assert.equal(report.stats.fileCount, 10);
    assert.equal(report.stats.pairCount, 12);
    assert.deepEqual(Object.keys(report.stats).sort(), ["elapsedMs", "fileCount", "pairCount"]);
    const described = report.pairs.map(describePair);
    assert.ok(described.includes("src/text/format.ts:cleanEscapedString<->src/text/lightFormat.ts:cleanEscapedString"), described.join("\n"));
    assert.ok(described.includes("src/types/arity.ts:FPArity<->src/types/quarter.ts:Quarter"));
    const optionsBlock = report.pairs.find((p) => rel(p.left) === "src/text/format.ts" && rel(p.right) === "src/text/parse.ts");
    assert.ok(optionsBlock, "clone between format.ts and parse.ts");
    assert.equal(optionsBlock.mode, "overlap");
    assert.equal(optionsBlock.left.kind, "fragment");
    assert.equal(optionsBlock.similarity, 1);
    for (const p of report.pairs) {
      assert.deepEqual(Object.keys(p).filter((k) => k !== "instances").sort(), ["left", "mode", "right", "similarity"]);
      assert.doesNotMatch(JSON.stringify({ ...p, left: { ...p.left, filePath: "" }, right: { ...p.right, filePath: "" }, instances: undefined }), /fallow|similarity-ts|fingerprint|clone|detectedBy/i);
    }
  });

  it("keeps a pair both detectors report only once, in its declaration shape", async () => {
    const lenient = await detect({ similarityTs: analyze, fallow: { minTokens: 20 } });
    const clean = lenient.pairs.filter((p) => describePair(p) === "src/text/format.ts:cleanEscapedString<->src/text/lightFormat.ts:cleanEscapedString");
    assert.equal(clean.length, 1);
    assert.equal(clean[0]!.mode, "functions");
    const strict = await detect({ similarityTs: analyze });
    assert.ok(lenient.stats.pairCount >= strict.stats.pairCount, "a lower clone floor never removes pairs");
  });

  it("limits the clone detector to the requested paths and excludes", async () => {
    const api = await detect({ similarityTs: { ...analyze, paths: ["src/api"], modes: ["functions"] } });
    assert.deepEqual(api.pairs.map(describePair), ["src/api/isFriday.ts:isFriday<->src/api/isMonday.ts:isMonday"]);
    const excluded = await detect({ similarityTs: { ...analyze, modes: ["functions"], exclude: ["**/parse.ts", "tests/**"] } });
    assert.ok(excluded.pairs.every((p) => !rel(p.left).endsWith("parse.ts") && !rel(p.right).endsWith("parse.ts")));
    assert.ok(excluded.pairs.every((p) => !rel(p.left).startsWith("tests/")));
  });

  it("fails the whole run when the clone detector does not run", async () => {
    await assert.rejects(
      detect({ similarityTs: analyze, fallow: { exec: async () => ({ stdout: JSON.stringify({ error: true, message: "no project here" }), code: 2 }) } }),
      (error: unknown) => error instanceof FallowError && /no project here/.test(error.message),
    );
  });
});

describe("runFallow", () => {
  const dupes = (groups: unknown[]) => JSON.stringify({ kind: "dupes", clone_groups: groups, clone_families: [], stats: {} });
  const group = (fingerprint: string, instances: [string, number, number][], extra: Record<string, unknown> = {}) => ({
    fingerprint,
    token_count: 60,
    line_count: 6,
    instances: instances.map(([file, start_line, end_line]) => ({ file, start_line, end_line, start_col: 0, end_col: 0 })),
    actions: [],
    ...extra,
  });

  it("runs every mode and turns a clone group into one pair across files with every instance attached", async () => {
    const modes: string[] = [];
    const result = await runFallow({
      cwd: "/repo",
      exec: async (args) => {
        assert.deepEqual(args.slice(0, 2), ["dupes", "--root"]);
        assert.ok(args.includes("--near") && args.includes("--no-fragments"));
        const mode = args[args.indexOf("--mode") + 1]!;
        modes.push(mode);
        if (mode !== "mild") return { stdout: dupes([]), code: 0 };
        return { stdout: dupes([group("dup:1", [["a.ts", 1, 6], ["a.ts", 20, 25], ["b/c.ts", 3, 8]], { similarity: 0.9, suggested_name: "helper" })]), code: 1 };
      },
    });
    assert.deepEqual(modes.sort(), ["mild", "semantic", "strict", "weak"]);
    assert.equal(result.pairs.length, 1);
    const [only] = result.pairs;
    assert.equal(only!.mode, "overlap");
    assert.equal(only!.similarity, 0.9);
    assert.equal(only!.left.filePath, path.resolve("/repo", "a.ts"));
    assert.equal(only!.right.filePath, path.resolve("/repo", "b/c.ts"), "a different file is preferred over a second instance in the same file");
    assert.equal(only!.left.symbolName, "helper");
    assert.equal(only!.left.kind, "fragment");
    assert.equal(only!.instances?.length, 3);
    assert.equal(result.cloneInstances, 3);
  });

  it("merges the groups different modes report for the same code, keeping the union of instances", async () => {
    const result = await runFallow({
      cwd: "/repo",
      exec: async (args) => {
        const mode = args[args.indexOf("--mode") + 1]!;
        const groups = {
          strict: [group("dup:s", [["a.ts", 1, 10], ["b.ts", 1, 10]])],
          mild: [group("dup:m", [["a.ts", 2, 10], ["b.ts", 1, 9], ["c.ts", 5, 14]], { similarity: 0.95 })],
          weak: [group("dup:w", [["x.ts", 1, 8], ["y.ts", 1, 8]])],
          semantic: [group("dup:e", [["a.ts", 1, 10], ["b.ts", 1, 10]], { similarity: 0.8 })],
        }[mode as "strict"];
        return { stdout: dupes(groups), code: 1 };
      },
    });
    assert.equal(result.pairs.length, 2, "a/b appears once, x/y once");
    const ab = result.pairs.find((p) => path.basename(p.left.filePath) === "a.ts")!;
    assert.equal(ab.similarity, 1, "an exact clone in one mode stays exact");
    assert.deepEqual(ab.instances?.map((i) => path.basename(i.filePath)), ["a.ts", "b.ts", "c.ts"], "the third place from the mild run is kept");
    assert.equal(result.cloneGroups, 2);
  });

  it("passes the limits through and drops instances outside the paths", async () => {
    let seen: string[] = [];
    const result = await runFallow({
      cwd: "/repo",
      paths: ["src"],
      exclude: ["**/*.generated.ts"],
      near: false,
      minTokens: 30,
      minLines: 4,
      exec: async (args) => {
        seen = args;
        return {
          stdout: dupes([
            group("dup:in", [["src/a.ts", 1, 6], ["src/b.ts", 1, 6]]),
            group("dup:out", [["src/a.ts", 10, 16], ["lib/x.ts", 1, 6]]),
            group("dup:gen", [["src/a.ts", 30, 36], ["src/z.generated.ts", 1, 6]]),
          ]),
          code: 0,
        };
      },
    });
    assert.ok(seen.includes("--min-tokens") && seen.includes("30") && seen.includes("--min-lines") && seen.includes("4"));
    assert.ok(!seen.includes("--near"));
    assert.deepEqual(result.pairs.map((p) => path.basename(p.right.filePath)), ["b.ts"], "the same group from four modes is one pair");
  });

  it("applies --exclude with gitignore semantics", async () => {
    const groups = [
      group("dup:a", [["src/a.ts", 1, 6], ["src/b.ts", 1, 6]]),
      group("dup:b", [["src/a.ts", 10, 16], ["src/gen/x.generated.ts", 1, 6]]),
      group("dup:c", [["src/a.ts", 20, 26], ["dist/a.ts", 1, 6]]),
      group("dup:d", [["src/a.ts", 30, 36], ["tests/deep/x.test.ts", 1, 6]]),
    ];
    const result = await runFallow({
      cwd: "/repo",
      exclude: ["*.generated.ts", "dist/", "tests/**"],
      exec: async () => ({ stdout: dupes(groups), code: 1 }),
    });
    assert.deepEqual(result.pairs.map((p) => path.basename(p.right.filePath)), ["b.ts"]);
  });

  it("scopes clone groups to one file or across files like the similarity-ts flags", async () => {
    const groups = [
      group("dup:mixed", [["a.ts", 1, 6], ["a.ts", 20, 25], ["a.ts", 40, 45], ["b.ts", 1, 6]]),
      group("dup:same", [["c.ts", 1, 6], ["c.ts", 30, 35]]),
    ];
    const exec = async () => ({ stdout: dupes(groups), code: 1 });
    const same = await runFallow({ cwd: "/repo", sameFileOnly: true, exec });
    assert.deepEqual(
      same.pairs.map((p) => `${path.basename(p.left.filePath)}:${p.left.startLine}-${path.basename(p.right.filePath)}:${p.right.startLine}`),
      ["a.ts:1-a.ts:40", "c.ts:1-c.ts:30"],
    );
    assert.equal(same.pairs[0]!.instances?.length, 3, "only the same-file instances stay in the group");
    const cross = await runFallow({ cwd: "/repo", crossFileOnly: true, exec });
    assert.deepEqual(cross.pairs.map((p) => `${path.basename(p.left.filePath)}-${path.basename(p.right.filePath)}`), ["a.ts-b.ts"]);
  });

  it("throws FallowError instead of returning half a report", async () => {
    await assert.rejects(runFallow({ exec: async () => ({ stdout: JSON.stringify({ error: true, message: "no project here" }), code: 2 }) }), /fallow dupes did not run: \w+ mode: no project here/);
    await assert.rejects(runFallow({ exec: async () => { throw new Error("spawn ENOENT"); } }), /spawn ENOENT/);
    await assert.rejects(runFallow({ exec: async () => ({ stdout: "not json", code: 0 }) }), /without JSON output/);
  });
});

describe("mergePairs", () => {
  const a = location("/r/a.ts", 10, 20, "fnA");
  const b = location("/r/b.ts", 30, 40, "fnB");

  it("folds a fragment pair into the declaration pair covering the same lines, in either order", () => {
    const declaration = pair(a, b);
    const fragment = pair(location("/r/b.ts", 33, 40, "(fragment)", "fragment"), location("/r/a.ts", 12, 19, "(fragment)", "fragment"), {
      mode: "overlap",
      similarity: 1,
      instances: [location("/r/b.ts", 33, 40), location("/r/a.ts", 12, 19), location("/r/c.ts", 1, 8)],
    });
    const merged = mergePairs([declaration], [fragment]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.mode, "functions");
    assert.equal(merged[0]!.similarity, 1, "the stronger score of the two reports is kept");
    assert.equal(merged[0]!.left.symbolName, "fnA", "the declaration side wins");
    assert.equal(merged[0]!.instances?.length, 3, "the clone family is carried over");
    assert.equal(declaration.instances, undefined, "inputs are not mutated");
  });

  it("keeps pairs apart when the ranges barely touch, one swallows the other, or the files differ", () => {
    const declaration = pair(a, b);
    const elsewhere = pair(location("/r/a.ts", 19, 30, "(fragment)", "fragment"), location("/r/b.ts", 39, 50, "(fragment)", "fragment"), { mode: "overlap" });
    const swallowing = pair(location("/r/a.ts", 1, 60, "(fragment)", "fragment"), location("/r/b.ts", 1, 60, "(fragment)", "fragment"), { mode: "overlap" });
    const otherFile = pair(location("/r/a.ts", 10, 20, "(fragment)", "fragment"), location("/r/d.ts", 30, 40, "(fragment)", "fragment"), { mode: "overlap" });
    assert.equal(mergePairs([declaration], [elsewhere, swallowing, otherFile]).length, 4);
  });
});

describe("groupFamilies", () => {
  it("connects declarations through pairs and clone instances", () => {
    const judged = (p: DetectedPair, score: number): JudgedPair => ({
      ...p,
      judgment: { score, confidence: 0.5, probabilities: {}, sameLogic: 0.9, sameConcept: 0.9, model: "jev" },
      verdict: { refactor: true, reason: "" },
    });
    const x = location("/r/x.ts", 1, 5, "x");
    const y = location("/r/y.ts", 1, 5, "y");
    const z = location("/r/z.ts", 1, 5, "z");
    const w = location("/r/w.ts", 1, 5, "w");
    const v = location("/r/v.ts", 1, 5, "v");
    const families = groupFamilies([
      judged(pair(x, y), 2.2),
      judged(pair(y, z), 2.6),
      judged(pair(w, v, { mode: "overlap", instances: [w, v, location("/r/u.ts", 1, 5, "u")] }), 2.0),
    ]);
    assert.equal(families.length, 2);
    assert.deepEqual(families[0]!.members.map((m: { symbolName: string }) => m.symbolName), ["x", "y", "z"]);
    assert.equal(families[0]!.pairs, 2);
    assert.equal(families[0]!.maxScore, 2.6);
    assert.ok(Math.abs(families[0]!.meanScore - 2.4) < 1e-9);
    assert.deepEqual(families[1]!.members.map((m: { symbolName: string }) => m.symbolName), ["u", "v", "w"]);
    assert.deepEqual(Object.keys(families[1]!).sort(), ["maxScore", "meanScore", "members", "pairs"]);
  });
});
