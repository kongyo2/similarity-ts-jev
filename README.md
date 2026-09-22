# @kongyo2/similarity-ts-jev

[![npm](https://img.shields.io/npm/v/@kongyo2/similarity-ts-jev)](https://www.npmjs.com/package/@kongyo2/similarity-ts-jev)
[![CI](https://github.com/kongyo2/similarity-ts-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/similarity-ts-jev/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@kongyo2/similarity-ts-jev)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@kongyo2/similarity-ts-jev)](LICENSE)

[`@kongyo2/similarity-ts`](https://www.npmjs.com/package/@kongyo2/similarity-ts) and
[`fallow`](https://www.npmjs.com/package/fallow) find code that looks alike.
This CLI runs both, has TypeSafe's [Jev](https://docs.typesafe.ai/) judge every
reported pair the way a code reviewer would, and prints only the pairs worth
merging, each with the change the reviewer would ask for.

```bash
export TYPESAFE_API_KEY=apikey_...   # https://console.typesafe.ai/keys
npx @kongyo2/similarity-ts-jev .
```

On date-fns (`pkgs/core/src`, tests and locales excluded) 2,207 similar pairs
go in and 62 families come out, in 8 seconds for about $0.22:

```
2.94  copy     pkgs/core/src/format/index.ts:444-452 cleanEscapedString <-> pkgs/core/src/lightFormat/index.ts:134-138 cleanEscapedString
2.80  copy
      pkgs/core/src/parse/_lib/parsers/AMPMMidnightParser.ts:52-59 set
      pkgs/core/src/parse/_lib/parsers/AMPMParser.ts:52-59 set
      pkgs/core/src/parse/_lib/parsers/DayPeriodParser.ts:53-60 set
2.73  copy     pkgs/core/src/parse/_lib/parsers/ISOTimezoneParser.ts:37-47 set <-> pkgs/core/src/parse/_lib/parsers/ISOTimezoneWithZParser.ts:37-47 set
2.58  copy     pkgs/core/src/parse/_lib/utils.ts:155-157 isLeapYearIndex <-> pkgs/core/src/parseISO/index.ts:278-280 isLeapYearIndex
2.52  extract
      pkgs/core/src/parse/_lib/parsers/AMPMMidnightParser.ts:9-50 parse
      pkgs/core/src/parse/_lib/parsers/AMPMParser.ts:9-50 parse
      pkgs/core/src/parse/_lib/parsers/DayParser.ts:10-49 dateString
      ...
2.49? copy     pkgs/core/src/parse/_lib/parsers/LocalWeekYearParser.ts:38-43 validate <-> pkgs/core/src/parse/_lib/parsers/YearParser.ts:48-53 validate
```

Each line is one family of declarations: the score (0–3), a flag, the shape of
the change, and where the members are. The `isFriday`/`isMonday` lookalikes and
the hundreds of per-function `Options` interfaces that merely share a shape stay
out. The output is empty when nothing is worth refactoring.

## Reading a line

| Column | Meaning |
| --- | --- |
| `2.94` | Jev's `refactor` score: how strongly a careful reviewer of this repository would ask for the two to be merged. Pairs at or over `--min-score` (default `1.9`) are reported. |
| flag | ` ` nothing to add. `?` Jev's confidence in the score is under `--unsure-below` (default `0.5`). `~` the score is within `--margin` (default `0.25`) of the cutoff. `!` under `--repeat`, the passes disagree on which side of the cutoff the pair falls. |
| `copy` / `derive` / `extract` | The single change a reviewer would ask for: delete one copy and import the other; express one in terms of the other; pull a shared helper out of both. |

The flags change the wording, never the list. On 132 hand-labeled pairs a low
confidence marked a weaker band (precision 0.40 under 0.5 against 0.72 above)
but dropping those pairs would have lost real duplicates, so they stay in with
a `?`.

## How it works

1. **Detect.** `similarity-ts` (functions, types, classes) and
   `fallow dupes --near` in each of its four modes run on the same paths.
   Their findings are merged into one list of pairs.
2. **Judge.** For every pair, Jev answers four independent questions over the
   two declarations (file path, leading comment, source text):
   - `refactor` (0–3): how strongly a careful reviewer would have them merged,
   - `same_logic`: same operations in the same order, names and literals aside,
   - `same_concept`: the same responsibility, or two things that look alike,
   - `shape`: which of `remove_copy`, `derive`, `extract_shared` the reviewer
     would ask for.

   Up to 64 pairs share one request, packed to about 50,000 estimated tokens
   with 32 requests in flight. Batching does not move the answers: across
   8,253 pairs, a pair judged alone and the same pair judged in a batch of 60
   differ by 0.055 on average, which is also the difference between two
   solo passes.
3. **Decide.** Pairs at or over `--min-score` are grouped into families of
   connected declarations, each printed once, best first.

## What to expect

Single pass with the defaults, four repositories at their September 2026
heads, tests excluded:

| Repository | Files | Pairs in | Families out | Requests | Input tokens | Cost | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| date-fns `pkgs/core/src` (locales excluded too) | 1,104 | 2,207 | 62 | 108 | 5.2M | $0.22 | 8.0 s |
| es-toolkit `src` | 848 | 596 | 59 | 43 | 1.9M | $0.08 | 4.6 s |
| remeda `packages/remeda/src` | 225 | 165 | 16 | 12 | 0.5M | $0.02 | 3.2 s |
| zod `packages/zod/src` | 134 | 5,285 | 117 | 237 | 10.7M | $0.45 | 19.8 s |

Roughly 2,000 to 3,000 input tokens per pair, so a thousand pairs cost about
ten cents and five seconds. `--dry-run` prints the counts first; its token
estimate landed within 5% of the billed count on each of these runs.

Against 132 pairs labeled by hand without looking at the scores, the score
ranks merges above keeps with an AUC of 0.93. At the default cutoff it reports
26 of the 30 merges and 19 of the 102 keeps (precision 0.58, recall 0.87,
accuracy 0.83). Almost every false positive is a repository convention that
only a maintainer knows: zod's locale files and its frozen v3 tree, es-toolkit's
lodash-compatible variants, remeda's mirror-image types. Those are what
`--conventions` is for.

## Fitting it to a repository

**`--conventions <text>`** sends a note on what the repository keeps separate
on purpose with every request:

```bash
npx @kongyo2/similarity-ts-jev packages/zod/src --exclude "**/*.test.ts" \
  --conventions "Every file under src/v4/locales is a self-contained translation and locale files are deliberately not shared with one another. src/v3 is a frozen previous major version kept apart from src/v4."
```

On the labeled pairs a note covering all four repositories moved precision
from 0.60 to 0.88 and accuracy from 0.84 to 0.92, and the shape agreed with
the label 90% of the time instead of 67%. Recall fell from 0.90 to 0.73: a
sentence like "every function is its own module" generalizes to its neighbors,
and on remeda it suppressed every real duplicate. Name the specific things
that are kept apart, not a policy, and check the effect with `--calibrate`.

**`--calibrate`** prints, instead of the results, the score histogram, the
widest gap between neighboring scores, the headroom on both sides of the
cutoff, and the confidence quantiles. With **`--labels <file>`** (a JSON
object from pair keys to `true` for merge or `false` for keep, in the form
`src/a.ts:12:name <-> src/b.ts:40:name`) it adds precision, recall, and
accuracy at the cutoff, the AUC of each signal, a fitted cutoff, a 5-fold
hold-out estimate, and the pairs it got wrong. Twenty to forty labels are
enough to tell whether the default cutoff or a note is doing its job.

**`--record <file>`** keeps every judgment of a run; **`--replay <file>`**
re-decides it under other `--min-score`, `--unsure-below`, or `--margin`
values with no detection and no requests, and takes `--calibrate` as well.
`--cache <file>` does the same at the request level: a re-run after an edit
asks only about the pairs whose text changed.

**`--repeat <n>`** asks every pair n times and decides on the mean score.
Two passes differ by 0.055 on average and by 0.14 at the 90th percentile;
only pairs within 0.25 of the cutoff ever change sides (12% of those, none
farther away). On zod, whose scores cluster around the cutoff, three passes
trimmed 317 reported pairs to 284 and marked 240 with `!`.

## Options

Detection options mirror `similarity-ts`:

| Option | Default | |
| --- | --- | --- |
| `--modes <list>` | `functions,types,classes` | add `overlap` for token windows |
| `-t, --threshold`, `--min-lines`, `--min-tokens`, `--no-size-penalty`, `--extensions`, `--types-only`, `--no-allow-cross-kind`, `--type-literals`, `--overlap-*` | as in similarity-ts | passed through |
| `--same-file-only`, `--cross-file-only`, `--exclude <pattern>` | as in similarity-ts | applied to both detectors |
| `--no-fallow-near` | near-miss on | disable fallow's near-miss detection |
| `--fallow-min-tokens`, `--fallow-min-lines` | `50`, `5` | clone size floor |

Judgment:

| Option | Default | |
| --- | --- | --- |
| `--min-score <0-3>` | `1.9` | lowest score reported |
| `--unsure-below <0-1>` | `0.5` | confidence under which a reported pair gets `?` |
| `--margin <0-3>` | `0.25` | distance to the cutoff within which a pair gets `~` |
| `--repeat <n>` | `1` | passes per pair; the mean decides, `!` marks disagreement |
| `--conventions <text>` | — | what this repository keeps separate on purpose |
| `--all` | off | also list the pairs Jev would keep as they are |
| `--max-pairs <n>` | all | judge only the n most similar pairs |
| `--concurrency <n>` | `32` | requests in flight; halved after a rate limit, recovered one per success |
| `--pairs-per-request <n>` | `64` | pairs packed into one request |
| `--budget-tokens <n>` | `50000` | estimated input tokens per request (the gateway ceiling is 65,536) |
| `--retries <n>` | `2` | extra attempts after a rate limit, server error, or connection failure |
| `--model <name>` | `TYPESAFE_DEFAULT_MODEL` or `jev-latest` | Jev model |
| `--base-url <url>` | `TYPESAFE_BASE_URL` or `https://api.typesafe.ai` | TypeSafe-compatible API root |
| `--timeout <ms>` | `60000` | per request attempt |

Output and bookkeeping:

| Option | Default | |
| --- | --- | --- |
| `--format pretty\|json`, `--output <path>` | `pretty` | as in similarity-ts |
| `--stats` | off | pairs, requests, tokens, cost, retries, and time (stderr for pretty, in the document for json) |
| `--cache <file>` | — | record every answer, replay it on later runs |
| `--record <file>`, `--replay <file>` | — | keep every judgment; re-decide without requests |
| `--calibrate`, `--labels <file>` | off | distribution, headroom, and accuracy instead of results |
| `--dry-run` | off | pair, request, token, and cost counts without asking Jev |
| `--fail-on-warnings`, `--fail-on-duplicates` | off | CI gates |

Exit codes: `0` done, `1` usage or analysis error (or a `--fail-on-*` gate
fired), `2` some pairs could not be judged.

`--format json` prints `results` (each with `score`, `confidence`,
`sameLogic`, `sameConcept`, `shape`, `shapeConfidence`, `unsure`,
`borderline`, `similarity`, `mode`, `left`/`right`, `instances` when a
fragment appears in more than two places, and `unstable` plus `passes` under
`--repeat`), `families` (`score`, `shape`, `unsure`, `borderline`,
`members`), `rejected` with `--all`, `unjudged` when some pairs failed, and
`thresholds` plus `stats` with `--stats`.

A request the gateway rejects as too large is split in half and asked again;
a rate limit halves the concurrency for a second. Both show up in `--stats`.

## Environment

`TYPESAFE_API_KEY` (required), `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`,
and `TYPESAFE_LOG_LEVEL`, as in `@typesafe-ai/sdk`. For a TypeSafe-compatible
gateway:

```bash
TYPESAFE_BASE_URL=https://ai-gateway.lolipop.jp TYPESAFE_DEFAULT_MODEL=typesafe/jev-latest
```

The code of each reported pair is sent to that endpoint and nowhere else.
Node 22 or newer.

## Library

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { analyzeWithJev, calibrate, formatCalibration } from "@kongyo2/similarity-ts-jev";

const report = await analyzeWithJev(new TypeSafeClient(), {
  detect: { similarityTs: { paths: ["src"], cwd: process.cwd() } },
  minScore: 1.9,
  repeat: 1,
  conventions: "Locale files are kept separate on purpose.",
});
for (const pair of report.results) {
  console.log(pair.judgment.score, pair.judgment.shape, pair.verdict.unsure, pair.left.symbolName, pair.right.symbolName);
}
console.log(formatCalibration(calibrate(report, process.cwd())));
```

`detect()`, `judgeReport()`, `buildRecord()`/`replayRecord()`, and the
lower-level pieces (`pairQuestions`, `batchPairs`, `judgePairs`,
`mergePasses`, `decide`, `groupFamilies`, `FileJudgeCache`, `estimateTokens`)
are exported too.

## Measurements

Every default above comes from 61,371 Jev requests over 8,253 pairs from the
four repositories, 132 hand labels, and the runs in the table: which question
form to use, whether batching or ordering moves the answers, what the file
paths and comments contribute, how stable a score is across passes, where the
gateway's ceilings are, and how throughput scales with concurrency.
[`docs/measurements.md`](docs/measurements.md) has the numbers and the
things that did not work; `docs/measurements/` has the raw summaries, the
labels, and the outputs of the runs above; `scripts/experiments/` reproduces
them.
