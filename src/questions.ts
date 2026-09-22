import { noul, score } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { PairSnippet, Snippet } from "./types.ts";

export const REFACTOR_LEVELS = [
  "Would not ask for a change: the two are meant to stay separate. Distinct documented operations or public entry points, unrelated concepts that merely share a shape, test fixtures, or generated code",
  "Would let it pass: the repeated part is a few lines of boilerplate or wiring, and a shared helper would save little while coupling code that has no reason to know about each other",
  "Would ask for one shared implementation: the same logic or shape is repeated, and one version, parameterized where the two differ, would keep both behaviors and read as well",
  "Would insist on merging: a copy of a whole implementation with at most cosmetic differences, so two copies will only drift apart",
] as const;

export const REFACTOR_QUESTION = "How strongly would a careful reviewer of this repository ask for `a` and `b` to be merged into one shared implementation?";

export function buildState(repository: string): Record<string, unknown> {
  return {
    task:
      "A structural similarity analyzer (similarity-ts) reported the two TypeScript declarations `a` and `b` in each question as near-duplicates. " +
      "Judge each pair the way a careful reviewer of this repository would when deciding whether to have them merged into one shared implementation. " +
      "The declarations are shown with their file paths, the comment block above them, and their source text.",
    repository,
  };
}

export function questionIds(index: number): { refactor: string; sameLogic: string; sameConcept: string } {
  return { refactor: `p${index}_refactor`, sameLogic: `p${index}_same_logic`, sameConcept: `p${index}_same_concept` };
}

export function pairQuestions(snippet: PairSnippet): Questions {
  const ids = questionIds(snippet.index);
  const a = describe(snippet.a);
  const b = describe(snippet.b);
  const kind = snippet.pair.mode === "types" ? "type" : snippet.pair.mode === "classes" ? "class" : "code";
  const family = snippet.alsoAt !== undefined && snippet.alsoAt.length > 0 ? { also_at: snippet.alsoAt } : {};
  return {
    [ids.refactor]: score({ question: REFACTOR_QUESTION, a, b, ...family }, REFACTOR_LEVELS),
    [ids.sameLogic]: noul(
      {
        question:
          kind === "type"
            ? "Setting aside the names, do `a` and `b` describe the same shape: the same members with the same types, in the same roles?"
            : "Setting aside identifier names and data literals (strings, numbers, property names), does `a` perform the same operations in the same order as `b`?",
        a,
        b,
      },
      {
        true: kind === "type" ? "Yes: one could replace the other member for member" : "Yes: one could replace the other after renaming identifiers and turning the differing literals into parameters",
        false:
          kind === "type"
            ? "No: they differ in a member, a member's type, or what the members are for"
            : "No: they differ in an operation, a condition, the order of steps, or in what they call",
      },
    ),
    [ids.sameConcept]: noul(
      {
        question:
          "Do `a` and `b` stand for the same concept or responsibility in this codebase, rather than two different things that happen to look alike?",
        a,
        b,
        ...family,
      },
      {
        true: "Yes: their names, documentation, and callers point at one and the same thing",
        false: "No: they stand for different things (different operations, units, entities, or stages) that only share their form",
      },
    ),
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

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function pairTokens(snippet: Pick<PairSnippet, "a" | "b" | "alsoAt">): number {
  const per =
    estimateTokens(JSON.stringify(describe(snippet.a))) +
    estimateTokens(JSON.stringify(describe(snippet.b))) +
    estimateTokens(JSON.stringify(snippet.alsoAt ?? []));
  return 3 * per + 3 * 120;
}

export interface BatchOptions {
  budgetTokens?: number;
  pairsPerRequest?: number;
}

export function batchPairs<T extends { tokens: number }>(pairs: T[], options: BatchOptions = {}): T[][] {
  const budget = options.budgetTokens ?? 20_000;
  const maxPairs = options.pairsPerRequest ?? 40;
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
