# @kongyo2/similarity-ts-jev

[![npm](https://img.shields.io/npm/v/@kongyo2/similarity-ts-jev)](https://www.npmjs.com/package/@kongyo2/similarity-ts-jev)
[![CI](https://github.com/kongyo2/similarity-ts-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/similarity-ts-jev/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@kongyo2/similarity-ts-jev)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@kongyo2/similarity-ts-jev)](LICENSE)

[`@kongyo2/similarity-ts`](https://www.npmjs.com/package/@kongyo2/similarity-ts) and
[`fallow`](https://www.npmjs.com/package/fallow) find code that looks alike.
This CLI runs both, has TypeSafe's [Jev](https://docs.typesafe.ai/) judge every
reported pair the way a code reviewer would, and prints only the pairs worth
merging.

```bash
export TYPESAFE_API_KEY=apikey_...   # https://console.typesafe.ai/keys
npx @kongyo2/similarity-ts-jev .
```

On date-fns `pkgs/core/src` with tests and locales excluded, 1,294 similar
pairs go in and 56 families come out — 25 seconds, about $0.07:

```
2.86  src/format/index.ts:444-452 cleanEscapedString <-> src/lightFormat/index.ts:134-138 cleanEscapedString
2.68  src/parse/_lib/utils.ts:155-157 isLeapYearIndex <-> src/parseISO/index.ts:278-280 isLeapYearIndex
2.59  src/parse/_lib/parsers/QuarterParser.ts:63-71 set <-> src/parse/_lib/parsers/StandAloneQuarterParser.ts:63-71 set
2.12
      src/eachDayOfInterval/index.ts:17-28 EachDayOfIntervalResult
      src/eachHourOfInterval/index.ts:15-26 EachHourOfIntervalResult
      src/eachMinuteOfInterval/index.ts:18-29 EachMinuteOfIntervalResult
      ...
```

Each line is one family of declarations: its score (0–3) and where the members
are. The `isFriday`/`isMonday` lookalikes and the hundreds of per-function
`Options` interfaces that merely share a shape stay out. The output is empty
when nothing is worth refactoring.

## How it works

1. **Detect.** `similarity-ts` (functions, types, classes) and
   `fallow dupes --near` in each of its four modes run on the same paths.
   Their findings are merged into one list of pairs.
2. **Judge.** For every pair, Jev answers three questions over the two
   declarations (file path, leading comment, source text):
   - `refactor` (0–3): how strongly a careful reviewer of this repository
     would ask for the two to be merged,
   - `same_logic`: same operations in the same order, names and literals aside,
   - `same_concept`: the same responsibility, or two things that look alike.
   Up to 40 pairs share one request.
3. **Report.** Pairs with `refactor >= 1.9` (`--min-score`) are grouped into
   families of connected declarations, each printed once, best first.

`--min-score 1.7` also includes the borderline pairs a reviewer might only
mention; `2.5` keeps copy-paste only.

## Options

Detection options mirror `similarity-ts`:

| Option | Default | |
| --- | --- | --- |
| `--modes <list>` | `functions,types,classes` | add `overlap` for token windows |
| `-t, --threshold`, `--min-lines`, `--min-tokens`, `--no-size-penalty`, `--extensions`, `--types-only`, `--no-allow-cross-kind`, `--type-literals`, `--overlap-*` | as in similarity-ts | passed through |
| `--same-file-only`, `--cross-file-only`, `--exclude <pattern>` | as in similarity-ts | applied to both detectors |
| `--no-fallow-near` | near-miss on | disable fallow's near-miss detection |
| `--fallow-min-tokens`, `--fallow-min-lines` | `50`, `5` | clone size floor |

Judgment and output:

| Option | Default | |
| --- | --- | --- |
| `--min-score <0-3>` | `1.9` | lowest score reported |
| `--all` | off | also list the pairs Jev would keep as they are |
| `--max-pairs <n>` | all | judge only the n most similar pairs |
| `--concurrency <n>` | `4` | requests in flight |
| `--pairs-per-request <n>` | `40` | pairs packed into one request |
| `--model <name>` | `jev-latest` | Jev model |
| `--base-url <url>` | `https://api.typesafe.ai` | TypeSafe-compatible API root |
| `--cache <file>` | — | record answers, replay them on later runs |
| `--timeout <ms>` | `60000` | per request attempt |
| `--dry-run` | off | print pair, request, and token counts without asking Jev |
| `--format pretty\|json`, `--output <path>` | `pretty` | as in similarity-ts |
| `--fail-on-warnings`, `--fail-on-duplicates` | off | CI gates |

Exit codes: `0` done, `1` usage or analysis error (or a `--fail-on-*` gate
fired), `2` some pairs could not be judged.

`--format json` prints `results` (each with `score`, `confidence`,
`sameLogic`, `sameConcept`, `similarity`, `mode`, `left`/`right`, and
`instances` when a fragment appears in more than two places), `families`,
`rejected` with `--all`, and `unjudged` when some pairs failed.

`--cache` records every answer and replays it on later runs: re-running after
a change or trying another `--min-score` costs no requests, and a fully
cached run needs no API key.

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
import { analyzeWithJev } from "@kongyo2/similarity-ts-jev";

const report = await analyzeWithJev(new TypeSafeClient(), {
  detect: { similarityTs: { paths: ["src"], cwd: process.cwd() } },
  minScore: 1.9,
});
for (const pair of report.results) console.log(pair.judgment.score, pair.left.symbolName, pair.right.symbolName);
```

`detect()`, `judgeReport()`, and the lower-level pieces (`pairQuestions`,
`batchPairs`, `judgePairs`, `decide`, `groupFamilies`, `FileJudgeCache`) are
exported too.
