# @kongyo2/similarity-ts-jev

[`@kongyo2/similarity-ts`](https://www.npmjs.com/package/@kongyo2/similarity-ts) and
[`fallow`](https://www.npmjs.com/package/fallow) find code that looks alike.
This CLI runs both, hands every reported pair to TypeSafe's
[Jev](https://docs.typesafe.ai/) through
[`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk), and
prints the pairs a careful reviewer would have merged.

```bash
export TYPESAFE_API_KEY=apikey_...   # https://console.typesafe.ai/keys
npx @kongyo2/similarity-ts-jev .
```

```
2.87  src/format/index.ts:444-452 cleanEscapedString <-> src/lightFormat/index.ts:134-138 cleanEscapedString
2.51  src/formatISO/index.ts:78-90 tzOffset <-> src/formatRFC3339/index.ts:71-83 tzOffset
2.08
      src/eachDayOfInterval/index.ts:17-28 EachDayOfIntervalResult
      src/eachHourOfInterval/index.ts:15-26 EachHourOfIntervalResult
      src/eachMinuteOfInterval/index.ts:18-29 EachMinuteOfIntervalResult
      src/eachMonthOfInterval/index.ts:14-25 EachMonthOfIntervalResult
      src/eachQuarterOfInterval/index.ts:19-30 EachQuarterOfIntervalResult
      src/eachWeekendOfInterval/index.ts:17-28 EachWeekendOfIntervalResult
      src/eachWeekOfInterval/index.ts:28-39 EachWeekOfIntervalResult
      src/eachYearOfInterval/index.ts:17-28 EachYearOfIntervalResult
2.07
      src/eachDayOfInterval/index.ts:60-90 (fragment)
      src/eachDayOfInterval/index.ts:72-85 step
      ...
```

The sample is date-fns `pkgs/core/src` with tests and locales excluded:
1,151 near-duplicates in, 8 families out, 16 seconds. `isFriday`/`isMonday`,
`compareAsc`/`compareDesc`, and the 900-odd per-function `Options`
interfaces that share a shape are not in the output; the private helper
copied between `format` and `lightFormat` comes first.

Each entry is one family of declarations worth merging: its score (0–3) and
the declarations. The output has no headings, counts, or timings, and it is
empty when nothing is worth refactoring.

## What it does

1. **Detect.** `analyzeProject` from `@kongyo2/similarity-ts` (functions,
   types, classes; `overlap` on request) and `fallow dupes --near` in each
   of its modes (strict, mild, weak, semantic) run on the same paths on every
   invocation (fallow is rooted at the working directory and, for a requested
   path outside it, at that path), and their findings form one list. A group several modes
   report is kept once with the union of its instances. A clone group becomes
   one pair (its two most distant instances) that carries every other place
   the fragment appears (`instances`); fragment-level findings of either tool
   are `mode: overlap` with `kind: fragment`. A pair both tools report is
   kept once. The output does not say which tool found a pair. When either
   detector fails, the run fails.
2. **Judge.** For every pair Jev answers three questions over the two
   declarations (file path, the comment block above, the source text):
   - `refactor` (score, 0–3): *how strongly would a careful reviewer of this
     repository ask for `a` and `b` to be merged into one shared
     implementation?* The levels are concrete reviewer reactions, from "would
     not ask: meant to stay separate" to "would insist: a copy that will
     drift".
   - `same_logic` (probability): the same operations in the same order,
     identifiers and data literals aside (for types: the same members).
   - `same_concept` (probability): the same concept or responsibility, rather
     than two things that happen to look alike.

   Up to 40 pairs share one request (about 20k tokens); the SDK's retries
   apply, and a request the API refuses is halved until single pairs pass.
3. **Decide.** A pair is reported when `refactor >= 1.9` (`--min-score`).
   Reported pairs are grouped into families of connected declarations, so
   eight identical result types reported as 28 pairs come out as one family,
   and each family is printed once.

The threshold is applied in code and does not appear in the question text,
so recalibrating it leaves the questions, and recorded answers, unchanged.

### Calibration (2026-09-22, jev-1.13.0)

Measured on date-fns, the similarity-ts repository, and a TypeSafe SDK
adapter, then re-drawn three times:

| Pairs | refactor score |
| --- | --- |
| Identical private helper in two modules; a test helper copied into 3–4 files; a duplicated 5-line block | 2.10–2.94 |
| Options-resolution block shared by `format` and `parse`; `formatISO`/`formatISO9075` bodies; eight identical generic result types | 1.84–2.14 |
| Mirrored `compareAsc`/`compareDesc`; separately documented `isFriday`/`isMonday`; type aliases kept apart on purpose | 1.43–1.82 |
| Per-function `Options` interfaces; test fixtures meant to duplicate; `Quarter = 1\|2\|3\|4` vs `FPArity = 1\|2\|3\|4` | 0.04–1.26 |

The same pair re-judged three times moved by 0.07 on average (0.27 at most,
on a fixture pair). The default threshold sits in the gap between the clear
merges (≥ 2.10) and the clear keeps (≤ 1.69). Scores between 1.7 and 2.1 are
pairs a reviewer might mention without asking for a change; `--min-score 1.7`
includes them, `--min-score 2.5` keeps copy-paste only.

Cost: about 1,300 input tokens per pair (the code is inside each of the
three questions), $0.042 per million tokens on Jev, so the date-fns run
above is about $0.06 and 16 seconds (8 of them detection: similarity-ts plus
four fallow runs).

## Options

Detection options mirror `similarity-ts` (same names and defaults, except
`--modes`, whose default omits `overlap`):

| Option | Default | |
| --- | --- | --- |
| `--modes <list>` | `functions,types,classes` | similarity-ts modes; add `overlap` for token windows |
| `-t, --threshold`, `--min-lines`, `--min-tokens`, `--no-size-penalty`, `--extensions`, `--types-only`, `--no-allow-cross-kind`, `--type-literals`, `--overlap-*` | as in similarity-ts | passed through to `analyzeProject` |
| `--same-file-only`, `--cross-file-only`, `--exclude` (repeatable, gitignore syntax) | as in similarity-ts | applied to both detectors: a clone group is split per file or dropped when it does not cross files, and excluded files leave every group |
| `--no-fallow-near` | near-miss on | disable `fallow dupes --near` (every mode still runs) |
| `--fallow-min-tokens`, `--fallow-min-lines` | fallow's own (50, 5) | clone size floor |

Judgment and output:

| Option | Default | |
| --- | --- | --- |
| `--min-score <0-3>` | `1.9` | lowest `refactor` score reported |
| `--all` | off | also list the pairs Jev would leave as they are (after a blank line; JSON: `rejected`) |
| `--max-pairs <n>` | all | judge only the n highest-similarity pairs (`--dry-run` counts the same n) |
| `--concurrency <n>` | `4` | Jev requests in flight |
| `--pairs-per-request <n>` | `40` | pairs packed into one request |
| `--model <name>` | `TYPESAFE_DEFAULT_MODEL` or `jev-latest` | Jev model |
| `--base-url <url>` | `TYPESAFE_BASE_URL` or `https://api.typesafe.ai` | TypeSafe-compatible API root |
| `--cache <file>` | — | record Jev's answers and replay them on later runs (re-thresholding costs no requests) |
| `--timeout <ms>` | `60000` | per request attempt |
| `--dry-run` | off | print `<pairs> pairs, <requests> requests, <tokens> tokens` without asking Jev; `--fail-on-warnings` applies |
| `--format pretty\|json`, `--output <path>` | `pretty` | as in similarity-ts |
| `--fail-on-warnings`, `--fail-on-duplicates` | off | exit 1 on detector warnings / when any pair is worth refactoring (CI gate) |

Exit codes: `0` done, `1` usage or analysis error (a detector failed, a
reported source file could not be read, or a CI gate fired), `2` some pairs
could not be judged (Jev failed after the SDK's retries). stderr says how many
and why; JSON lists them under `unjudged` with a `reason` (`capped`,
`unreadable`, `api`). A run whose answers all come from `--cache` needs no
API key; rejected requests are recorded too, so a replay never contacts the
API. Cache entries are keyed by the request, including the model in effect
(`--model`, `TYPESAFE_DEFAULT_MODEL`, or `jev-latest`).

### JSON

`--format json` prints one document with `results` (the pairs worth
refactoring, best first: `score`, `confidence`, `sameLogic`,
`sameConcept`, `similarity`, `mode` (`functions`, `types`, `classes`,
`overlap`), `left`/`right` (`filePath`, `startLine`, `endLine`,
`symbolName`, `kind`), and `instances` when a fragment appears in more than
two places) and `families` (`score`, `members`). `rejected` is added with
`--all`, `unjudged` (each with its `reason` and `error`) only when some pairs
were not judged. There are no other fields.

### Environment

Only `@typesafe-ai/sdk`'s variables: `TYPESAFE_API_KEY` (required),
`TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` for a TypeSafe-compatible
endpoint (Lolipop AI Gateway: `TYPESAFE_BASE_URL=https://ai-gateway.lolipop.jp
TYPESAFE_DEFAULT_MODEL=typesafe/jev-latest`; `--base-url` and `--model` set
the same two), `TYPESAFE_LOG_LEVEL`. Nothing
is sent anywhere but that endpoint; the code of each reported pair is part of
the request.

## Library

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { analyzeWithJev, detect, judgeReport } from "@kongyo2/similarity-ts-jev";

const report = await analyzeWithJev(new TypeSafeClient(), {
  detect: { similarityTs: { paths: ["src"], cwd: process.cwd() } },
  minScore: 1.9,
});
for (const pair of report.results) console.log(pair.judgment.score, pair.left.symbolName, pair.right.symbolName);
```

`detect()` runs both detectors and returns the merged pairs;
`judgeReport(detection, client)` judges them with any object that has
`TypeSafeClient`'s `systemOne`. Lower-level pieces are exported too:
`pairQuestions`, `batchPairs`, `judgePairs`, `decide`, `groupFamilies`,
`FileJudgeCache`.
