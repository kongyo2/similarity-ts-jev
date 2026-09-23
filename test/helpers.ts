import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import type { CacheFile } from "../src/cache.ts";
import type { JudgeClient } from "../src/judge.ts";
import type { AnalyzerLocation, DetectedPair, Judgment } from "../src/types.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_PROJECT = path.join(ROOT, "test", "fixtures", "project");
export const FIXTURE_CACHE = path.join(ROOT, "test", "fixtures", "jev-cache.json");

function fixtureModel(): string {
  const file = JSON.parse(readFileSync(FIXTURE_CACHE, "utf8")) as CacheFile;
  const models = new Set(Object.values(file.entries).map((entry) => entry.request.model ?? "jev-latest"));
  if (models.size !== 1)
    throw new Error(`the fixture cache was recorded under ${models.size} model names: ${[...models].join(", ")}`);
  return [...models][0]!;
}

export const FIXTURE_MODEL = fixtureModel();

export const silent = { log() {}, error() {} };

type Handler = (request: {
  state: unknown;
  questions: Questions;
  model?: string;
}) => Promise<SystemOneResult<Questions>> | SystemOneResult<Questions>;

export function stubClient(
  handler: Handler,
  requestId = "req_test",
  defaultModel?: string,
): JudgeClient & { calls: number } {
  const client = {
    calls: 0,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
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

export const offline = stubClient(
  () => {
    throw new Error("the network was reached although every answer should come from the cache");
  },
  "req_test",
  FIXTURE_MODEL,
);

export function answerAll(
  request: { questions: Questions },
  scoreFor?: (instructions: string) => number,
): SystemOneResult<Questions> {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const instructions = JSON.stringify(question.instructions);
    const merge = instructions.includes("MERGE_ME");
    if (question.type === "score") {
      const score = scoreFor !== undefined ? scoreFor(instructions) : merge ? 2.5 : 0.5;
      answers[id] = merge
        ? { type: "score", score, confidence: 0.8, probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5 } }
        : { type: "score", score, confidence: 0.6, probabilities: { "0": 0.5, "1": 0.5, "2": 0, "3": 0 } };
    } else if (question.type === "noul") {
      answers[id] = { type: "noul", noul: merge ? 0.9 : 0.2 };
    } else if (question.type === "choice") {
      answers[id] = merge
        ? {
            type: "choice",
            choice: "remove_copy",
            confidence: 0.9,
            probabilities: { remove_copy: 0.9, derive: 0.05, extract_shared: 0.05 },
          }
        : {
            type: "choice",
            choice: "extract_shared",
            confidence: 0.5,
            probabilities: { remove_copy: 0.2, derive: 0.3, extract_shared: 0.5 },
          };
    }
  }
  return {
    model: "jev-1.13.0",
    answers: answers as SystemOneResult<Questions>["answers"],
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

export function judgment(score: number, extra: Partial<Judgment> = {}): Judgment {
  return {
    score,
    confidence: 0.7,
    probabilities: {},
    sameLogic: 0.9,
    sameConcept: 0.9,
    shape: "remove_copy",
    shapeConfidence: 0.8,
    shapeProbabilities: { remove_copy: 0.8, derive: 0.1, extract_shared: 0.1 },
    model: "jev",
    ...extra,
  };
}

export function location(
  filePath: string,
  startLine: number,
  endLine: number,
  symbolName = "x",
  kind = "function",
): AnalyzerLocation {
  return { filePath, startLine, endLine, symbolName, kind };
}

export function pair(left: AnalyzerLocation, right: AnalyzerLocation, extra: Partial<DetectedPair> = {}): DetectedPair {
  return { mode: "functions", similarity: 0.95, left, right, ...extra };
}
