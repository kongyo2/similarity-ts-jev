import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auc, calibrate, fitCutoff, formatCalibration, holdOut, labelOf, pairKey, widestGap } from "../src/calibrate.ts";
import { decide, thresholds } from "../src/decide.ts";
import type { JevReport, JudgedPair } from "../src/types.ts";
import { judgment, location, pair } from "./helpers.ts";

function judged(index: number, score: number, extra: Parameters<typeof judgment>[1] = {}): JudgedPair {
  const j = judgment(score, extra);
  return { ...pair(location(`/r/a${index}.ts`, 1, 5, `a${index}`), location(`/r/b${index}.ts`, 10, 15, `b${index}`)), judgment: j, verdict: decide(j) };
}

function report(pairs: JudgedPair[], passes = 1): JevReport {
  const results = pairs.filter((p) => p.verdict.refactor);
  const rejected = pairs.filter((p) => !p.verdict.refactor);
  return {
    analyzedFiles: [],
    skippedFiles: [],
    warnings: [],
    results,
    families: [],
    rejected,
    rejectedCount: rejected.length,
    unjudged: [],
    thresholds: thresholds(),
    stats: { fileCount: 2, pairCount: pairs.length, elapsedMs: 0, judged: pairs.length, unjudged: 0, requests: 1, inputTokens: 100, outputTokens: 10, cacheHits: 0, retries: 0, rateLimited: 0, splits: 0, passes, usd: 0 },
  };
}

describe("calibrate", () => {
  it("keys pairs the way scripts/verify.ts prints them, in either order", () => {
    const p = judged(1, 2.0);
    assert.equal(pairKey(p, "/r"), "a1.ts:1:a1 <-> b1.ts:10:b1");
    assert.equal(labelOf({ "b1.ts:10:b1 <-> a1.ts:1:a1": false }, p, "/r"), false);
    assert.equal(labelOf({}, p, "/r"), undefined);
  });

  it("finds the widest gap, ranks with AUC, and fits a cutoff in the gap when the classes separate", () => {
    assert.deepEqual(widestGap([0.5, 0.6, 2.4, 2.5]), { gap: 1.8, low: 0.6, high: 2.4 });
    assert.equal(auc([2, 3], [0, 1]), 1);
    assert.equal(auc([1, 1], [1, 1]), 0.5);
    const cases = [
      { key: "a", merge: true, pair: judged(0, 2.4) },
      { key: "b", merge: true, pair: judged(1, 2.6) },
      { key: "c", merge: false, pair: judged(2, 0.6) },
      { key: "d", merge: false, pair: judged(3, 1.2) },
    ];
    const fit = fitCutoff(cases, (c) => c.pair.judgment.score);
    assert.deepEqual(fit, { cutoff: 1.8, separable: true, lowestMerge: 2.4, highestKeep: 1.2 });
    const overlapping = [...cases, { key: "e", merge: false, pair: judged(4, 2.5) }];
    const best = fitCutoff(overlapping, (c) => c.pair.judgment.score);
    assert.equal(best.separable, false);
    assert.equal(best.cutoff, 2.4, "the cutoff that gains the most true positives net of false positives and misses: 2 - 1 - 0 at 2.4 beats 1 - 0 - 1 at 2.6");
    const held = holdOut(cases, (c) => c.pair.judgment.score, 2);
    assert.equal(held.accuracy, 1);
    assert.equal(held.cutoffs.length, 2);
  });

  it("lets the fit report nothing when every labeled pair is a keep, and reports no hold-out accuracy without an evaluated fold", () => {
    const keeps = [
      { key: "a", merge: false, pair: judged(0, 0.5) },
      { key: "b", merge: false, pair: judged(1, 1.0) },
    ];
    const fit = fitCutoff(keeps, (c) => c.pair.judgment.score);
    assert.deepEqual(fit, { cutoff: 1.01, separable: false, lowestMerge: Number.NaN, highestKeep: 1.0 }, "a cutoff above the highest score flags nothing, which beats flagging a keep");
    const mixed = [...keeps, { key: "c", merge: true, pair: judged(2, 2.0) }, { key: "d", merge: false, pair: judged(3, 2.5) }];
    assert.equal(fitCutoff(mixed, (c) => c.pair.judgment.score).cutoff, 2.0, "one true positive and one false positive still beat reporting nothing");
    const single = holdOut([keeps[0]!], (c) => c.pair.judgment.score);
    assert.ok(Number.isNaN(single.accuracy));
    assert.deepEqual(single.cutoffs, []);
    const two = holdOut(keeps, (c) => c.pair.judgment.score);
    assert.equal(two.accuracy, 0.5, "trained on the lower keep alone, the fit sits just above it and flags the higher keep");
    assert.equal(two.falsePositives, 1);
    assert.deepEqual(two.cutoffs, [1.01, 0.51]);
  });

  it("describes the distribution, the headroom, the unsure band, and the labeled accuracy", () => {
    const pairs = [judged(0, 2.6, { confidence: 0.8 }), judged(1, 2.0, { confidence: 0.2 }), judged(2, 1.8), judged(3, 0.4), judged(4, 1.0)];
    const labels = { "a0.ts:1:a0 <-> b0.ts:10:b0": true, "a1.ts:1:a1 <-> b1.ts:10:b1": false, "a2.ts:1:a2 <-> b2.ts:10:b2": true, "a3.ts:1:a3 <-> b3.ts:10:b3": false, "zz <-> zz": false };
    const c = calibrate(report(pairs), "/r", labels);
    assert.equal(c.judged, 5);
    assert.equal(c.over, 2);
    assert.equal(c.borderline, 2, "2.0 and 1.8 sit within 0.25 of 1.9");
    assert.equal(c.unsure, 1);
    assert.equal(c.histogram.reduce((sum, bin) => sum + bin.count, 0), 5);
    assert.deepEqual(c.headroom, { highestBelow: 1.8, lowestAbove: 2.0 });
    assert.equal(c.passes, null);
    assert.equal(c.labels?.labeled, 4);
    assert.equal(c.labels?.unmatched, 1);
    assert.deepEqual(c.labels?.atCutoff, { cutoff: 1.9, tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5, accuracy: 0.5 });
    assert.equal(c.labels?.signals.score.auc, 0.75);
    assert.equal(c.labels?.unsureBand.unsure, 1);
    assert.equal(c.labels?.unsureBand.unsurePrecision, 0);
    assert.equal(c.labels?.unsureBand.surePrecision, 1);
    assert.deepEqual(c.labels?.wrong.map((w) => w.key), ["a1.ts:1:a1 <-> b1.ts:10:b1", "a2.ts:1:a2 <-> b2.ts:10:b2"]);
    const text = formatCalibration(c);
    assert.match(text, /5 judged pairs; 2 at or over 1.90, 2 within 0.25 of it, 1 reported with confidence under 0.50/);
    assert.match(text, /labels: 4 labeled pairs found \(2 merge, 2 keep\), 1 labels matched no pair/);
    assert.match(text, /score\s+AUC 0.75/);
    assert.match(text, /wrong: 2.00/);
  });

  it("summarizes the passes of a repeated run", () => {
    const pairs = [judged(0, 2.0, { passes: { count: 3, scores: [1.8, 2.0, 2.2], spread: 0.4 } }), judged(1, 0.5, { passes: { count: 3, scores: [0.5, 0.5, 0.5], spread: 0 } })];
    const c = calibrate(report(pairs, 3), "/r");
    assert.deepEqual(c.passes, { count: 3, spreadMean: 0.2, spreadP90: 0.4, unstable: 1 });
    assert.match(formatCalibration(c), /3 passes: mean spread 0.20, p90 0.40; 1 pairs crossed the cutoff between passes/);
  });
});
