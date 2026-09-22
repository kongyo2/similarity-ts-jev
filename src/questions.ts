import { choice, noul, score } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { PairSnippet, Shape, Snippet } from "./types.ts";

export const TASK =
  "A structural similarity analyzer reported the two TypeScript declarations `a` and `b` in each question as near-duplicates. " +
  "Judge each pair the way a careful reviewer of this repository would when deciding whether to have them merged into one shared implementation. " +
  "The declarations are shown with their file paths, the comment block above them, and their source text. " +
  "The pairs in this request are unrelated to one another: judge each pair only on its own two declarations, and do not compare or rank pairs against each other.";

export const REFACTOR_QUESTION = "How strongly would a careful reviewer of this repository ask for `a` and `b` to be merged into one shared implementation?";

export const REFACTOR_LEVELS = [
  "Would not ask for a change: the two are meant to stay separate. Distinct documented operations or public entry points, unrelated concepts that merely share a shape, test fixtures, or generated code",
  "Would let it pass: the repeated part is a few lines of boilerplate or wiring, and a shared helper would save little while coupling code that has no reason to know about each other",
  "Would ask for one shared implementation: the same logic or shape is repeated, and one version, parameterized where the two differ, would keep both behaviors and read as well",
  "Would insist on merging: a copy of a whole implementation with at most cosmetic differences, so two copies will only drift apart",
] as const;

export const SAME_LOGIC = {
  code: {
    question: "Setting aside identifier names and data literals (strings, numbers, property names), does `a` perform the same operations in the same order as `b`?",
    true: "Yes: one could replace the other after renaming identifiers and turning the differing literals into parameters",
    false: "No: they differ in an operation, a condition, the order of steps, or in what they call",
  },
  type: {
    question: "Setting aside the names, do `a` and `b` describe the same shape: the same members with the same types, in the same roles?",
    true: "Yes: one could replace the other member for member",
    false: "No: they differ in a member, a member's type, or what the members are for",
  },
} as const;

export const SAME_CONCEPT = {
  question: "Do `a` and `b` stand for the same concept or responsibility in this codebase, rather than two different things that happen to look alike?",
  true: "Yes: their names, documentation, and callers point at one and the same thing",
  false: "No: they stand for different things (different operations, units, entities, or stages) that only share their form",
} as const;

export const SHAPE_QUESTION = "If a reviewer had `a` and `b` merged, which single change would they ask for?";

export const SHAPE_OPTIONS: Record<Shape, string> = {
  remove_copy: "Keep one declaration and delete the other; whatever used the deleted one uses the survivor instead. Right when the two are the same thing twice, with at most cosmetic differences.",
  derive: "Keep both names, but write one in terms of the other: one function calls the other with fixed arguments or a small wrapper, or one type is written as an extension, Pick, Omit, or intersection of the other. Right when one is a special case or a subset of the other.",
  extract_shared: "Introduce a third, shared piece (a helper function or a base type) that carries the common part, parameterized where the two differ, and reduce both `a` and `b` to what is specific to each. Right when both are specializations of something neither of them is.",
};

export const SHAPES: readonly Shape[] = ["remove_copy", "derive", "extract_shared"];

export interface StateOptions {
  conventions?: string;
}

export function buildState(repository: string, options: StateOptions = {}): Record<string, unknown> {
  return {
    task: TASK,
    repository,
    ...(options.conventions !== undefined && options.conventions.trim() !== "" ? { repository_conventions: options.conventions.trim() } : {}),
  };
}

export interface QuestionIds {
  refactor: string;
  sameLogic: string;
  sameConcept: string;
  shape: string;
}

export function questionIds(index: number): QuestionIds {
  return { refactor: `p${index}_refactor`, sameLogic: `p${index}_same_logic`, sameConcept: `p${index}_same_concept`, shape: `p${index}_shape` };
}

export function pairQuestions(snippet: PairSnippet): Questions {
  const ids = questionIds(snippet.index);
  const a = describe(snippet.a);
  const b = describe(snippet.b);
  const kind = snippet.pair.mode === "types" ? "type" : "code";
  const family = snippet.alsoAt !== undefined && snippet.alsoAt.length > 0 ? { also_at: snippet.alsoAt } : {};
  const logic = SAME_LOGIC[kind];
  return {
    [ids.refactor]: score({ question: REFACTOR_QUESTION, a, b, ...family }, REFACTOR_LEVELS),
    [ids.sameLogic]: noul({ question: logic.question, a, b }, { true: logic.true, false: logic.false }),
    [ids.sameConcept]: noul({ question: SAME_CONCEPT.question, a, b, ...family }, { true: SAME_CONCEPT.true, false: SAME_CONCEPT.false }),
    [ids.shape]: choice({ question: SHAPE_QUESTION, a, b, ...family }, SHAPE_OPTIONS),
  };
}

function describe(snippet: Snippet): Record<string, string> {
  return {
    path: snippet.path,
    lines: snippet.lines,
    kind: snippet.kind,
    name: snippet.name,
    ...(snippet.doc !== undefined ? { doc: snippet.doc } : {}),
    code: snippet.code,
  };
}

const CHARS_PER_TOKEN_TEXT = 3.4;
const CHARS_PER_TOKEN_STRUCT = 2.2;
const TEXT_LIKE_LENGTH = 64;
const QUESTION_ENTRY_OVERHEAD = 4;

export function estimateTokens(value: unknown): number {
  return Math.ceil(cost(value));
}

function cost(value: unknown): number {
  if (typeof value === "string") {
    const length = JSON.stringify(value).length;
    return length / (value.length >= TEXT_LIKE_LENGTH ? CHARS_PER_TOKEN_TEXT : CHARS_PER_TOKEN_STRUCT);
  }
  if (value === null || typeof value !== "object") return String(value).length / CHARS_PER_TOKEN_STRUCT;
  if (Array.isArray(value)) return (2 + Math.max(0, value.length - 1)) / CHARS_PER_TOKEN_STRUCT + value.reduce((sum: number, item) => sum + cost(item), 0);
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  let total = (2 + Math.max(0, entries.length - 1)) / CHARS_PER_TOKEN_STRUCT;
  for (const [key, v] of entries) total += (JSON.stringify(key).length + 1) / CHARS_PER_TOKEN_STRUCT + cost(v);
  return total;
}

export function pairTokens(snippet: PairSnippet): number {
  const questions = pairQuestions(snippet);
  return Object.values(questions).reduce((sum, question) => sum + estimateTokens(question) + QUESTION_ENTRY_OVERHEAD, 0);
}

export const MAX_REQUEST_TOKENS = 65_536;
export const DEFAULT_BUDGET_TOKENS = 50_000;
export const DEFAULT_PAIRS_PER_REQUEST = 64;

export interface BatchOptions {
  budgetTokens?: number;
  pairsPerRequest?: number;
}

export function batchPairs<T extends { tokens: number }>(pairs: T[], options: BatchOptions = {}): T[][] {
  const budget = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const maxPairs = options.pairsPerRequest ?? DEFAULT_PAIRS_PER_REQUEST;
  const batches: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const pair of pairs) {
    if (current.length > 0 && (used + pair.tokens > budget || current.length >= maxPairs)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(pair);
    used += pair.tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
