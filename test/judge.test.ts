import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestError, InternalServerError } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { decide } from "../src/decide.ts";
import { judgePairs, requestHash, toJudgment } from "../src/judge.ts";
import type { JudgeCache, JudgeRequest, JudgeResponse } from "../src/judge.ts";
import { REFACTOR_LEVELS, batchPairs, pairQuestions, pairTokens, questionIds } from "../src/questions.ts";
import type { PairSnippet } from "../src/types.ts";
import { answerAll, location, pair, stubClient } from "./helpers.ts";

function snippet(index: number, code: string, extra: Partial<PairSnippet> = {}): PairSnippet {
  const p = pair(location(`/r/a${index}.ts`, 1, 5, `a${index}`), location(`/r/b${index}.ts`, 1, 5, `b${index}`));
  const a = { path: `a${index}.ts`, lines: "1-5", kind: "function", name: `a${index}`, code };
  const b = { path: `b${index}.ts`, lines: "1-5", kind: "function", name: `b${index}`, code };
  const s: PairSnippet = { index, pair: p, a, b, tokens: 0, ...extra };
  s.tokens = pairTokens(s);
  return s;
}

describe("questions", () => {
  it("asks one score and two nouls per pair, with the code inside each question", () => {
    const s = snippet(3, "return x + 1;", { alsoAt: ["c.ts:1-5"] });
    const questions = pairQuestions(s);
    const ids = questionIds(3);
    assert.deepEqual(Object.keys(questions), [ids.refactor, ids.sameLogic, ids.sameConcept]);
    const refactor = questions[ids.refactor]!;
    assert.equal(refactor.type, "score");
    assert.equal((refactor as { criteria: readonly unknown[] }).criteria.length, REFACTOR_LEVELS.length);
    const instructions = refactor.instructions as Record<string, unknown>;
    assert.deepEqual(instructions.a, { path: "a3.ts", lines: "1-5", kind: "function", name: "a3", code: "return x + 1;" });
    assert.deepEqual(instructions.also_at, ["c.ts:1-5"], "a clone family lists its other places");
    assert.equal(questions[ids.sameLogic]!.type, "noul");
    assert.ok(JSON.stringify(questions[ids.sameLogic]!.instructions).includes("return x + 1;"));
  });

  it("packs pairs into requests under the token budget", () => {
    const small = Array.from({ length: 5 }, (_, i) => snippet(i, "x".repeat(300)));
    assert.equal(batchPairs(small, { budgetTokens: 100_000, pairsPerRequest: 2 }).length, 3);
    const big = snippet(9, "y".repeat(30_000));
    const batches = batchPairs([small[0]!, big, small[1]!], { budgetTokens: 5000 });
    assert.deepEqual(batches.map((b) => b.map((s) => s.index)), [[0], [9], [1]], "an oversized pair travels alone");
  });
});

describe("judgePairs", () => {
  it("answers every pair from one request and reads the three answers", async () => {
    const snippets = [snippet(0, "MERGE_ME"), snippet(1, "leave")];
    const client = stubClient(answerAll);
    const outcome = await judgePairs(snippets, client, { repository: "r" });
    assert.equal(client.calls, 1);
    assert.equal(outcome.stats.requests, 1);
    assert.equal(outcome.stats.inputTokens, 100);
    assert.equal(outcome.failures.size, 0);
    const merge = outcome.judgments.get(0)!;
    assert.equal(merge.score, 2.5);
    assert.equal(merge.sameLogic, 0.9);
    assert.equal(merge.sameConcept, 0.9);
    assert.equal(merge.model, "jev-1.13.0");
    assert.equal(merge.requestId, "req_test");
    assert.equal(outcome.judgments.get(1)!.score, 0.5);
    assert.equal(decide(merge).refactor, true);
    assert.equal(decide(outcome.judgments.get(1)!).refactor, false);
    assert.equal(decide(merge, { minScore: 2.6 }).reason, "score<2.60");
  });

  it("splits a batch the API refuses (400/422) until single pairs pass, and reports a pair that never passes", async () => {
    const snippets = [snippet(0, "MERGE_ME"), snippet(1, "b"), snippet(2, "TOO_BIG"), snippet(3, "d")];
    const client = stubClient((request) => {
      const ids = Object.keys(request.questions);
      if (ids.length > 3) throw new BadRequestError(400, { error_type: "max_tokens_exceeded" }, new Headers());
      if (JSON.stringify(request.questions).includes("TOO_BIG")) throw new BadRequestError(400, { error_type: "max_tokens_exceeded" }, new Headers());
      return answerAll(request);
    });
    const outcome = await judgePairs(snippets, client, { concurrency: 1 });
    assert.deepEqual([...outcome.judgments.keys()].sort(), [0, 1, 3]);
    assert.match(outcome.failures.get(2)!, /BadRequestError: 400/);
    assert.equal(outcome.stats.judged, 3);
    assert.equal(outcome.stats.unjudged, 1);
    assert.ok(client.calls >= 5, `attempts: ${client.calls}`);
  });

  it("marks a whole batch unjudged on other API failures and keeps going", async () => {
    const snippets = [snippet(0, "a"), snippet(1, "b")];
    let calls = 0;
    const client = stubClient((request) => {
      calls += 1;
      if (calls === 1) throw new InternalServerError(503, { error: "overloaded" }, new Headers());
      return answerAll(request);
    });
    const outcome = await judgePairs(snippets, client, { pairsPerRequest: 1, concurrency: 1 });
    assert.equal(outcome.judgments.size, 1);
    assert.match(outcome.failures.get(0)!, /InternalServerError: 503 overloaded/);
  });

  it("replays from the cache and records misses", async () => {
    const store = new Map<string, { request: JudgeRequest; response: JudgeResponse }>();
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

  it("rejects an answer set that lacks a pair's questions", () => {
    const s = snippet(7, "x");
    const questions: Questions = pairQuestions(s);
    const ids = questionIds(7);
    const response = answerAll({ questions });
    assert.equal(toJudgment(s, response).score, 0.5);
    const partial = { ...response, answers: { [ids.refactor]: response.answers[ids.refactor]! } } as JudgeResponse;
    assert.throws(() => toJudgment(s, partial), /no same_logic answer/);
  });
});
