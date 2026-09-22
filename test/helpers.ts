import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import type { JudgeClient } from "../src/judge.ts";
import type { AnalyzerLocation, DetectedPair } from "../src/types.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_PROJECT = path.join(ROOT, "test", "fixtures", "project");
export const FIXTURE_CACHE = path.join(ROOT, "test", "fixtures", "jev-cache.json");

export const silent = { log() {}, error() {} };

type Handler = (request: { state: unknown; questions: Questions; model?: string }) => Promise<SystemOneResult<Questions>> | SystemOneResult<Questions>;

export function stubClient(handler: Handler, requestId = "req_test"): JudgeClient & { calls: number } {
  const client = {
    calls: 0,
    systemOne(request: { state: unknown; questions: Questions; model?: string }) {
      client.calls += 1;
      const pending = Promise.resolve().then(() => handler(request));
      return Object.assign(pending, {
        withResponse: async () => ({ data: await pending, response: new Response(null), requestId }),
      });
    },
  };
  return client as unknown as JudgeClient & { calls: number };
}

export const offline = stubClient(() => {
  throw new Error("the network was reached although every answer should come from the cache");
});

export function answerAll(request: { questions: Questions }): SystemOneResult<Questions> {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const instructions = JSON.stringify(question.instructions);
    const merge = instructions.includes("MERGE_ME");
    if (question.type === "score") {
      answers[id] = merge
        ? { type: "score", score: 2.5, confidence: 0.8, probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5 } }
        : { type: "score", score: 0.5, confidence: 0.6, probabilities: { "0": 0.5, "1": 0.5, "2": 0, "3": 0 } };
    } else if (question.type === "noul") {
      answers[id] = { type: "noul", noul: merge ? 0.9 : 0.2 };
    }
  }
  return { model: "jev-1.13.0", answers: answers as SystemOneResult<Questions>["answers"], usage: { input_tokens: 100, output_tokens: 10 } };
}

export function location(filePath: string, startLine: number, endLine: number, symbolName = "x", kind = "function"): AnalyzerLocation {
  return { filePath, startLine, endLine, symbolName, kind };
}

export function pair(left: AnalyzerLocation, right: AnalyzerLocation, extra: Partial<DetectedPair> = {}): DetectedPair {
  return { mode: "functions", similarity: 0.95, left, right, ...extra };
}
