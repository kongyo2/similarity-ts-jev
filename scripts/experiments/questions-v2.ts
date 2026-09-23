import { choice, noul, score } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import {
  REFACTOR_LEVELS,
  REFACTOR_QUESTION,
  SAME_CONCEPT,
  SAME_LOGIC,
  SHAPE_OPTIONS,
  SHAPE_QUESTION,
  TASK,
} from "../../src/questions.ts";
import type { PairSnippet, Snippet } from "../../src/types.ts";

export type Variant = "long" | "compact" | "state";
export type Kind = "refactor" | "same_logic" | "same_concept" | "shape";
export const KINDS: Kind[] = ["refactor", "same_logic", "same_concept", "shape"];

const REFACTOR_LABELS = [
  "would not ask for a change",
  "would let it pass",
  "would ask for one shared implementation",
  "would insist on merging",
] as const;

export interface Options {
  doc?: boolean;
  paths?: boolean;
  conventions?: string;
}

function questionIds(index: number): Record<Kind, string> {
  return {
    refactor: `p${index}_refactor`,
    same_logic: `p${index}_same_logic`,
    same_concept: `p${index}_same_concept`,
    shape: `p${index}_shape`,
  };
}

function pairRef(index: number): string {
  return `p${index}`;
}

function describe(snippet: Snippet, options: Options, side: "a" | "b"): Record<string, string> {
  const paths = options.paths ?? true;
  return {
    path: paths ? snippet.path : `${side}.ts`,
    lines: snippet.lines,
    kind: snippet.kind,
    name: snippet.name,
    ...((options.doc ?? true) && snippet.doc !== undefined ? { doc: snippet.doc } : {}),
    code: snippet.code,
  };
}

function kindOf(snippet: PairSnippet): "type" | "code" {
  return snippet.pair.mode === "types" ? "type" : "code";
}

function subjectFields(snippet: PairSnippet, variant: Variant, options: Options): Record<string, unknown> {
  if (variant === "state") return { pair: pairRef(snippet.index) };
  const family = snippet.alsoAt !== undefined && snippet.alsoAt.length > 0 ? { also_at: snippet.alsoAt } : {};
  return { a: describe(snippet.a, options, "a"), b: describe(snippet.b, options, "b"), ...family };
}

export function buildState(
  repository: string,
  variant: Variant,
  batch: PairSnippet[] = [],
  options: Options = {},
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    task: TASK,
    repository,
    ...(options.conventions !== undefined ? { repository_conventions: options.conventions } : {}),
  };
  if (variant === "long") return state;
  state.definitions = {
    refactor: {
      question: REFACTOR_QUESTION,
      levels: Object.fromEntries(REFACTOR_LEVELS.map((level, i) => [String(i), level])),
    },
    same_logic: { code: SAME_LOGIC.code, type: SAME_LOGIC.type },
    same_concept: SAME_CONCEPT,
    shape: { question: SHAPE_QUESTION, options: SHAPE_OPTIONS },
  };
  state.note_on_questions =
    "Each question names the judgment it asks for (`judge`) and the definition under `definitions` applies verbatim; for `same_logic` the entry for the pair's `kind` (code or type) applies.";
  if (variant === "state") {
    state.pairs = Object.fromEntries(
      batch.map((snippet) => [
        pairRef(snippet.index),
        {
          kind: kindOf(snippet),
          a: describe(snippet.a, options, "a"),
          b: describe(snippet.b, options, "b"),
          ...(snippet.alsoAt !== undefined && snippet.alsoAt.length > 0 ? { also_at: snippet.alsoAt } : {}),
        },
      ]),
    );
    state.note_on_pairs =
      "Each question names one entry of `pairs` (`pair`); `a` and `b` in the definitions refer to that entry's `a` and `b`.";
  }
  return state;
}

export function pairQuestions(
  snippet: PairSnippet,
  variant: Variant,
  kinds: Iterable<Kind> = KINDS,
  options: Options = {},
): Questions {
  const ids = questionIds(snippet.index);
  const kind = kindOf(snippet);
  const subject = subjectFields(snippet, variant, options);
  const questions: Questions = {};
  for (const which of kinds) {
    if (which === "refactor") {
      questions[ids.refactor] =
        variant === "long"
          ? score({ question: REFACTOR_QUESTION, ...subject }, REFACTOR_LEVELS)
          : score({ judge: "refactor", ...subject }, REFACTOR_LABELS);
    } else if (which === "same_logic") {
      const definition = SAME_LOGIC[kind];
      questions[ids.same_logic] =
        variant === "long"
          ? noul({ question: definition.question, ...subject }, { true: definition.true, false: definition.false })
          : noul({ judge: "same_logic", kind, ...subject }, { true: "yes", false: "no" });
    } else if (which === "same_concept") {
      questions[ids.same_concept] =
        variant === "long"
          ? noul(
              { question: SAME_CONCEPT.question, ...subject },
              { true: SAME_CONCEPT.true, false: SAME_CONCEPT.false },
            )
          : noul({ judge: "same_concept", ...subject }, { true: "yes", false: "no" });
    } else {
      questions[ids.shape] =
        variant === "long"
          ? choice({ question: SHAPE_QUESTION, ...subject }, SHAPE_OPTIONS)
          : choice({ judge: "shape", ...subject }, { remove_copy: null, derive: null, extract_shared: null });
    }
  }
  return questions;
}

export interface Read {
  refactor?: { score: number; confidence: number; probabilities: Record<string, number> };
  same_logic?: number;
  same_concept?: number;
  shape?: { choice: string; confidence: number; probabilities: Record<string, number> };
}

export function readAnswers(index: number, answers: Record<string, unknown>): Read {
  const ids = questionIds(index);
  const out: Read = {};
  const refactor = answers[ids.refactor] as
    { type?: string; score?: number; confidence?: number; probabilities?: Record<string, number> } | undefined;
  if (refactor?.type === "score" && typeof refactor.score === "number") {
    out.refactor = {
      score: refactor.score,
      confidence: refactor.confidence ?? 0,
      probabilities: refactor.probabilities ?? {},
    };
  }
  const logic = answers[ids.same_logic] as { type?: string; noul?: number } | undefined;
  if (logic?.type === "noul" && typeof logic.noul === "number") out.same_logic = logic.noul;
  const concept = answers[ids.same_concept] as { type?: string; noul?: number } | undefined;
  if (concept?.type === "noul" && typeof concept.noul === "number") out.same_concept = concept.noul;
  const shape = answers[ids.shape] as
    { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined;
  if (shape?.type === "choice" && typeof shape.choice === "string") {
    out.shape = { choice: shape.choice, confidence: shape.confidence ?? 0, probabilities: shape.probabilities ?? {} };
  }
  return out;
}
