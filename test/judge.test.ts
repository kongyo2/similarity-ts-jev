import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestError, InternalServerError, RateLimitError } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { decide } from "../src/decide.ts";
import { AdaptiveLimiter, judgePairs, mergePasses, requestHash, toJudgment } from "../src/judge.ts";
import type { JudgeCache, JudgeRejection, JudgeRequest, JudgeResponse } from "../src/judge.ts";
import {
  REFACTOR_LEVELS,
  SHAPES,
  batchPairs,
  buildState,
  estimateTokens,
  pairQuestions,
  pairTokens,
  questionIds,
} from "../src/questions.ts";
import type { PairSnippet } from "../src/types.ts";
import { answerAll, judgment, location, pair, stubClient } from "./helpers.ts";

function snippet(index: number, code: string, extra: Partial<PairSnippet> = {}): PairSnippet {
  const p = pair(location(`/r/a${index}.ts`, 1, 5, `a${index}`), location(`/r/b${index}.ts`, 1, 5, `b${index}`));
  const a = { path: `a${index}.ts`, lines: "1-5", kind: "function", name: `a${index}`, code };
  const b = { path: `b${index}.ts`, lines: "1-5", kind: "function", name: `b${index}`, code };
  const s: PairSnippet = { index, pair: p, a, b, tokens: 0, ...extra };
  s.tokens = pairTokens(s);
  return s;
}

describe("questions", () => {
  it("asks one score, two nouls, and one shape choice per pair, with the code inside each question", () => {
    const s = snippet(3, "return x + 1;", { alsoAt: ["c.ts:1-5"] });
    const questions = pairQuestions(s);
    const ids = questionIds(3);
    assert.deepEqual(Object.keys(questions), [ids.refactor, ids.sameLogic, ids.sameConcept, ids.shape]);
    const refactor = questions[ids.refactor]!;
    assert.equal(refactor.type, "score");
    assert.equal((refactor as { criteria: readonly unknown[] }).criteria.length, REFACTOR_LEVELS.length);
    const instructions = refactor.instructions as Record<string, unknown>;
    assert.deepEqual(instructions.a, {
      path: "a3.ts",
      lines: "1-5",
      kind: "function",
      name: "a3",
      code: "return x + 1;",
    });
    assert.deepEqual(instructions.also_at, ["c.ts:1-5"], "a clone family lists its other places");
    assert.equal(questions[ids.sameLogic]!.type, "noul");
    assert.ok(JSON.stringify(questions[ids.sameLogic]!.instructions).includes("return x + 1;"));
    const shape = questions[ids.shape]!;
    assert.equal(shape.type, "choice");
    assert.deepEqual(Object.keys((shape as { criteria: Record<string, string> }).criteria), [...SHAPES]);
    assert.ok(JSON.stringify(shape.instructions).includes("return x + 1;"), "the shape question carries the code too");
  });

  it("names the repository and its conventions in the state, and nothing else about the pairs", () => {
    assert.deepEqual(Object.keys(buildState("repo")), ["task", "repository"]);
    const state = buildState("repo", { conventions: "  locale files are kept apart  " });
    assert.equal(state.repository_conventions, "locale files are kept apart");
    assert.ok(String(state.task).includes("unrelated to one another"));
    assert.deepEqual(Object.keys(buildState("repo", { conventions: "   " })), ["task", "repository"]);
  });

  it("estimates tokens from the serialized shape and packs pairs under the budget", () => {
    assert.ok(estimateTokens("x".repeat(340)) >= 100 && estimateTokens("x".repeat(340)) <= 101);
    assert.ok(estimateTokens({ a: 1 }) >= 3);
    const small = Array.from({ length: 5 }, (_, i) => snippet(i, "x".repeat(300)));
    assert.equal(batchPairs(small, { budgetTokens: 100_000, pairsPerRequest: 2 }).length, 3);
    const big = snippet(9, "y".repeat(30_000));
    const batches = batchPairs([small[0]!, big, small[1]!], { budgetTokens: 5000 });
    assert.deepEqual(
      batches.map((b) => b.map((s) => s.index)),
      [[0], [9], [1]],
      "an oversized pair travels alone",
    );
    assert.ok(pairTokens(snippet(0, "x".repeat(2000))) > 4 * 600, "four questions each carry both declarations");
  });
});

describe("judgePairs", () => {
  it("answers every pair from one request and reads the four answers", async () => {
    const snippets = [snippet(0, "MERGE_ME"), snippet(1, "leave")];
    const client = stubClient(answerAll);
    const outcome = await judgePairs(snippets, client, { repository: "r" });
    assert.equal(client.calls, 1);
    assert.equal(outcome.stats.requests, 1);
    assert.equal(outcome.stats.inputTokens, 100);
    assert.equal(outcome.stats.passes, 1);
    assert.ok(outcome.stats.usd > 0 && outcome.stats.usd < 0.001);
    assert.equal(outcome.failures.size, 0);
    const merge = outcome.judgments.get(0)!;
    assert.equal(merge.score, 2.5);
    assert.equal(merge.sameLogic, 0.9);
    assert.equal(merge.sameConcept, 0.9);
    assert.equal(merge.shape, "remove_copy");
    assert.equal(merge.shapeConfidence, 0.9);
    assert.equal(merge.model, "jev-1.13.0");
    assert.equal(merge.requestId, "req_test");
    assert.equal(merge.passes, undefined, "a single pass records no passes");
    assert.equal(outcome.judgments.get(1)!.score, 0.5);
    assert.equal(outcome.judgments.get(1)!.shape, "extract_shared");
    assert.equal(decide(merge).refactor, true);
    assert.equal(decide(outcome.judgments.get(1)!).refactor, false);
    assert.equal(decide(merge, { minScore: 2.6 }).reason, "score<2.60 (borderline)");
  });

  it("splits a batch the API refuses (400/422) until single pairs pass, and reports a pair that never passes", async () => {
    const snippets = [snippet(0, "MERGE_ME"), snippet(1, "b"), snippet(2, "TOO_BIG"), snippet(3, "d")];
    const client = stubClient((request) => {
      const ids = Object.keys(request.questions);
      if (ids.length > 12) throw new BadRequestError(400, { error: { message: "Invalid request" } }, new Headers());
      if (JSON.stringify(request.questions).includes("TOO_BIG"))
        throw new BadRequestError(400, { error_type: "max_tokens_exceeded" }, new Headers());
      return answerAll(request);
    });
    const outcome = await judgePairs(snippets, client, { concurrency: 1 });
    assert.deepEqual([...outcome.judgments.keys()].sort(), [0, 1, 3]);
    assert.match(outcome.failures.get(2)!, /BadRequestError: 400/);
    assert.equal(outcome.stats.judged, 3);
    assert.equal(outcome.stats.unjudged, 1);
    assert.equal(outcome.stats.splits, 2);
    assert.equal(client.calls, 5, "4 pairs, then 2+2, then 1+1 for the rejected half");
    assert.equal(outcome.stats.requests, client.calls, "rejected batches count as requests too");
  });

  it("replays split batches from the cache without reaching the API", async () => {
    const store = new Map<string, { request: JudgeRequest; response: JudgeResponse | JudgeRejection }>();
    const cache: JudgeCache = {
      get: (hash) => store.get(hash)?.response,
      set: (hash, request, response) => void store.set(hash, { request, response }),
    };
    const snippets = [snippet(0, "MERGE_ME"), snippet(1, "b"), snippet(2, "TOO_BIG"), snippet(3, "d")];
    const rejecting = stubClient((request) => {
      const text = JSON.stringify(request.questions);
      if (Object.keys(request.questions).length > 12 || text.includes("TOO_BIG"))
        throw new BadRequestError(400, { error_type: "max_tokens_exceeded" }, new Headers());
      return answerAll(request);
    });
    const first = await judgePairs(snippets, rejecting, { cache, repository: "r", concurrency: 1 });
    assert.deepEqual([...first.judgments.keys()].sort(), [0, 1, 3]);
    assert.equal(
      [...store.values()].filter((entry) => "rejected" in entry.response).length,
      3,
      "the parent, the oversized half, and the single oversized pair are recorded as rejections",
    );
    const offline = stubClient(() => {
      throw new Error("offline");
    });
    const replayed = await judgePairs(snippets, offline, { cache, repository: "r", concurrency: 1 });
    assert.equal(offline.calls, 0);
    assert.deepEqual([...replayed.judgments.keys()].sort(), [0, 1, 3]);
    assert.match(replayed.failures.get(2)!, /400/);
    assert.equal(replayed.stats.cacheHits, 5);
    assert.equal(replayed.stats.requests, 0);
  });

  it("retries a rate limit or a server error, halving the concurrency after a rate limit, and gives up after the retries", async () => {
    const snippets = [snippet(0, "a"), snippet(1, "b")];
    let calls = 0;
    const client = stubClient((request) => {
      calls += 1;
      if (calls === 1) throw new RateLimitError(429, { error: "slow down" }, new Headers());
      if (calls === 2) throw new InternalServerError(503, { error: "overloaded" }, new Headers());
      return answerAll(request);
    });
    const outcome = await judgePairs(snippets, client, { pairsPerRequest: 2, concurrency: 8, retries: 2 });
    assert.equal(outcome.judgments.size, 2);
    assert.equal(outcome.stats.retries, 2);
    assert.equal(outcome.stats.rateLimited, 1);
    assert.equal(outcome.stats.requests, 3, "the failed attempts are requests too");

    const failing = stubClient(() => {
      throw new InternalServerError(503, { error: "overloaded" }, new Headers());
    });
    const failed = await judgePairs(snippets, failing, { pairsPerRequest: 1, concurrency: 1, retries: 1 });
    assert.equal(failed.judgments.size, 0);
    assert.equal(failing.calls, 4, "one attempt and one retry per batch");
    assert.match(failed.failures.get(0)!, /InternalServerError: 503 overloaded/);
  });

  it("asks every batch once per pass, decides on the mean, and records the spread of the passes", async () => {
    const snippets = [snippet(0, "MERGE_ME"), snippet(1, "b")];
    let calls = 0;
    const client = stubClient((request) => {
      calls += 1;
      return answerAll(request, (instructions) => (instructions.includes("MERGE_ME") ? 2.5 - 0.3 * (calls - 1) : 0.5));
    });
    const outcome = await judgePairs(snippets, client, { repeat: 3, concurrency: 1 });
    assert.equal(client.calls, 3);
    assert.equal(outcome.stats.passes, 3);
    const merge = outcome.judgments.get(0)!;
    assert.deepEqual(merge.passes?.scores, [2.5, 2.2, 1.9]);
    assert.ok(Math.abs(merge.score - 2.2) < 1e-9, "the mean decides");
    assert.equal(merge.passes?.spread, 0.6);
    assert.equal(merge.shape, "remove_copy");
    assert.equal(decide(merge).unstable, false, "every pass is at or over 1.9");
    assert.equal(decide(merge, { minScore: 2.0 }).unstable, true, "one pass fell under 2.0");
    assert.equal(outcome.judgments.get(1)!.passes?.spread, 0);
  });

  it("leaves a pair unjudged when one of its passes failed, instead of deciding on a partial mean", async () => {
    const snippets = [snippet(0, "MERGE_ME"), snippet(1, "b")];
    let calls = 0;
    const client = stubClient((request) => {
      calls += 1;
      if (calls === 2) throw new InternalServerError(503, { error: "overloaded" }, new Headers());
      return answerAll(request);
    });
    const outcome = await judgePairs(snippets, client, { repeat: 2, concurrency: 1, retries: 0 });
    assert.equal(client.calls, 2);
    assert.equal(outcome.judgments.size, 0, "the first pass answered, the second did not");
    assert.equal(outcome.stats.unjudged, 2);
    assert.match(outcome.failures.get(0)!, /InternalServerError: 503 overloaded/);
    assert.match(outcome.failures.get(1)!, /InternalServerError: 503 overloaded/);
  });

  it("keys the cache by pass, so a repeated run replays every pass", async () => {
    const store = new Map<string, { request: JudgeRequest; response: JudgeResponse | JudgeRejection }>();
    const cache: JudgeCache = {
      get: (hash) => store.get(hash)?.response,
      set: (hash, request, response) => void store.set(hash, { request, response }),
    };
    const snippets = [snippet(0, "MERGE_ME")];
    await judgePairs(snippets, stubClient(answerAll), { cache, repository: "r", repeat: 2 });
    assert.equal(store.size, 2);
    assert.deepEqual(
      [...store.values()].map((entry) => entry.request.pass),
      [undefined, 2],
      "pass 1 shares the hash of a single run",
    );
    const replayed = await judgePairs(
      snippets,
      stubClient(() => {
        throw new Error("should replay");
      }),
      { cache, repository: "r", repeat: 2 },
    );
    assert.equal(replayed.stats.cacheHits, 2);
    assert.equal(replayed.judgments.get(0)!.passes?.count, 2);
  });

  it("marks a whole batch unjudged on other API failures and keeps going", async () => {
    const snippets = [snippet(0, "a"), snippet(1, "b")];
    let calls = 0;
    const client = stubClient((request) => {
      calls += 1;
      if (calls === 1) throw new InternalServerError(503, { error: "overloaded" }, new Headers());
      return answerAll(request);
    });
    const outcome = await judgePairs(snippets, client, { pairsPerRequest: 1, concurrency: 1, retries: 0 });
    assert.equal(outcome.judgments.size, 1);
    assert.match(outcome.failures.get(0)!, /InternalServerError: 503 overloaded/);
  });

  it("replays from the cache and records misses", async () => {
    const store = new Map<string, { request: JudgeRequest; response: JudgeResponse | JudgeRejection }>();
    const cache: JudgeCache = {
      get: (hash) => store.get(hash)?.response,
      set: (hash, request, response) => void store.set(hash, { request, response }),
    };
    const snippets = [snippet(0, "MERGE_ME")];
    const first = stubClient(answerAll);
    await judgePairs(snippets, first, { cache, repository: "r" });
    assert.equal(first.calls, 1);
    assert.equal(store.size, 1);
    const second = stubClient(() => {
      throw new Error("should replay");
    });
    const replayed = await judgePairs(snippets, second, { cache, repository: "r" });
    assert.equal(second.calls, 0);
    assert.equal(replayed.stats.cacheHits, 1);
    assert.equal(replayed.judgments.get(0)!.score, 2.5);
    const [hash] = store.keys();
    assert.equal(hash, requestHash(store.get(hash!)!.request));
  });

  it("puts the client's default model and the conventions into the request, so caches are keyed by both", async () => {
    const seen: (string | undefined)[] = [];
    const record = (request: { model?: string; questions: Questions }) => {
      seen.push(request.model);
      return answerAll(request);
    };
    const snippets = [snippet(0, "x")];
    await judgePairs(snippets, stubClient(record, "req", "typesafe/jev-latest"), { repository: "r" });
    await judgePairs(snippets, stubClient(record), { repository: "r" });
    await judgePairs(snippets, stubClient(record, "req", "typesafe/jev-latest"), {
      repository: "r",
      model: "jev-1.13.0",
    });
    assert.deepEqual(seen, ["typesafe/jev-latest", undefined, "jev-1.13.0"]);
    const hashes = new Set<string>();
    const cache: JudgeCache = { get: () => undefined, set: (hash) => void hashes.add(hash) };
    await judgePairs(snippets, stubClient(answerAll, "req", "a"), { repository: "r", cache });
    await judgePairs(snippets, stubClient(answerAll, "req", "b"), { repository: "r", cache });
    await judgePairs(snippets, stubClient(answerAll, "req", "b"), {
      repository: "r",
      cache,
      conventions: "locales stay apart",
    });
    assert.equal(hashes.size, 3);
  });

  it("rejects an answer set that lacks a pair's questions", () => {
    const s = snippet(7, "x");
    const questions: Questions = pairQuestions(s);
    const ids = questionIds(7);
    const response = answerAll({ questions });
    assert.equal(toJudgment(s, response).score, 0.5);
    const partial = { ...response, answers: { [ids.refactor]: response.answers[ids.refactor]! } } as JudgeResponse;
    assert.throws(() => toJudgment(s, partial), /no same_logic answer/);
    const noShape = {
      ...response,
      answers: { ...response.answers, [ids.shape]: { type: "choice", choice: "other" } },
    } as unknown as JudgeResponse;
    assert.throws(() => toJudgment(s, noShape), /no shape answer/);
  });
});

describe("mergePasses", () => {
  it("averages the numbers and takes the majority shape, with the first pass breaking ties", () => {
    const merged = mergePasses([
      judgment(2.0, { confidence: 0.4, shape: "derive", probabilities: { "2": 1 } }),
      judgment(2.4, { confidence: 0.6, shape: "extract_shared", probabilities: { "2": 0.5, "3": 0.5 } }),
    ]);
    assert.equal(merged.score, 2.2);
    assert.equal(merged.confidence, 0.5);
    assert.deepEqual(merged.probabilities, { "2": 0.75, "3": 0.25 });
    assert.equal(merged.shape, "derive");
    assert.deepEqual(merged.passes, { count: 2, scores: [2.0, 2.4], spread: 0.4 });
    assert.equal(
      mergePasses([
        judgment(1.0, { shape: "derive" }),
        judgment(1.0, { shape: "extract_shared" }),
        judgment(1.0, { shape: "extract_shared" }),
      ]).shape,
      "extract_shared",
    );
  });
});

describe("AdaptiveLimiter", () => {
  it("never runs more than its limit at once, halves after a throttle, and grows back one at a time", async () => {
    const limiter = new AdaptiveLimiter(4);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    };
    await Promise.all(Array.from({ length: 10 }, () => limiter.run(task)));
    assert.equal(peak, 4);
    limiter.throttle();
    assert.equal(limiter.limit, 2);
    limiter.throttle();
    limiter.throttle();
    assert.equal(limiter.limit, 1, "never under one");
    peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => limiter.run(task)));
    assert.equal(peak, 1);
    limiter.recover();
    limiter.recover();
    assert.equal(limiter.limit, 3);
    for (let i = 0; i < 10; i += 1) limiter.recover();
    assert.equal(limiter.limit, 4, "never over the configured concurrency");
  });
});
