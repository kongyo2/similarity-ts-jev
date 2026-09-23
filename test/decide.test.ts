import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MARGIN, DEFAULT_MIN_SCORE, DEFAULT_UNSURE_BELOW, decide, thresholds } from "../src/decide.ts";
import { judgment } from "./helpers.ts";

describe("decide", () => {
  it("reports at or over the cutoff, never gating on confidence", () => {
    assert.deepEqual(thresholds(), {
      minScore: DEFAULT_MIN_SCORE,
      unsureBelow: DEFAULT_UNSURE_BELOW,
      margin: DEFAULT_MARGIN,
    });
    const sure = decide(judgment(2.6, { confidence: 0.9 }));
    assert.deepEqual(sure, {
      refactor: true,
      unsure: false,
      borderline: false,
      unstable: false,
      reason: "score>=1.90",
    });
    const unsure = decide(judgment(2.6, { confidence: 0.1 }));
    assert.equal(unsure.refactor, true, "a low confidence changes the wording, not the list");
    assert.equal(unsure.unsure, true);
    assert.equal(unsure.reason, "score>=1.90 (unsure)");
    assert.equal(decide(judgment(1.0, { confidence: 0.1 })).unsure, false, "only reported pairs are unsure");
  });

  it("marks the band around the cutoff on both sides, and lets the thresholds move", () => {
    assert.equal(decide(judgment(1.7)).borderline, true);
    assert.equal(decide(judgment(2.1)).borderline, true);
    assert.equal(decide(judgment(2.15)).borderline, false);
    assert.equal(decide(judgment(1.65)).borderline, false);
    assert.equal(decide(judgment(1.7), { margin: 0.1 }).borderline, false);
    assert.equal(decide(judgment(1.7), { minScore: 1.5 }).refactor, true);
    assert.equal(decide(judgment(2.0, { confidence: 0.55 }), { unsureBelow: 0.6 }).unsure, true);
    assert.equal(
      decide(judgment(2.0, { confidence: 0.55 }), { unsureBelow: 0.6 }).reason,
      "score>=1.90 (unsure, borderline)",
    );
  });

  it("marks a pair unstable only when its passes disagree across the cutoff", () => {
    const steady = judgment(2.3, { passes: { count: 3, scores: [2.2, 2.3, 2.4], spread: 0.2 } });
    assert.equal(decide(steady).unstable, false);
    const crossing = judgment(2.0, { passes: { count: 3, scores: [1.8, 2.0, 2.2], spread: 0.4 } });
    assert.equal(decide(crossing).unstable, true);
    assert.equal(decide(crossing).reason, "score>=1.90 (borderline, unstable)");
    assert.equal(
      decide(judgment(2.4, { passes: { count: 2, scores: [1.8, 3.0], spread: 1.2 } })).reason,
      "score>=1.90 (unstable)",
    );
    assert.equal(decide(crossing, { minScore: 1.7 }).unstable, false);
    assert.equal(decide(judgment(2.0)).unstable, false, "a single pass cannot be unstable");
  });
});
