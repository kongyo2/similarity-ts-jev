# Measurements behind the defaults

Every default of `similarity-ts-jev` 0.2.0 comes from measurements against
TypeSafe's Jev through a TypeSafe-compatible gateway (`typesafe/jev-latest`,
September 2026): 61,371 requests and 196 million input tokens in the
measurement harness (`scripts/experiments/`), plus 1,633 requests and 73
million tokens running the finished CLI on the same repositories. The raw
summary is `docs/measurements/summary.json`; the outputs of the CLI runs are
under `docs/measurements/cli/`; the hand labels are under
`docs/measurements/labels/`.

## Corpora

Four repositories at their heads on the dates below, with tests excluded, run
through both detectors with the default settings (`functions,types,classes`
for similarity-ts, `fallow dupes --near` in every mode):

| Repository | Commit                 | Paths                 | Also excluded            | Pairs | functions / types / classes / overlap |
| ---------- | ---------------------- | --------------------- | ------------------------ | ----: | ------------------------------------- |
| date-fns   | `717ce0a` (2026-09-22) | `pkgs/core/src`       | `**/locale/**`, `*.d.ts` | 2,207 | 181 / 993 / 10 / 1,023                |
| es-toolkit | `ee72fc7` (2026-09-19) | `src`                 | `*.spec.ts`, `*.d.ts`    |   596 | 308 / 103 / 1 / 184                   |
| remeda     | `e8292dd` (2026-09-16) | `packages/remeda/src` | `*.test-d.ts`, `*.d.ts`  |   165 | 49 / 20 / 0 / 96                      |
| zod        | `10dda3a` (2026-09-21) | `packages/zod/src`    | `**/tests/**`, `*.d.ts`  | 5,285 | 4,619 / 222 / 3 / 441                 |

8,253 pairs in total. The harness snapshots the pairs once
(`run.ts snapshot`) so that every arm judges exactly the same text.

## The gateway

Measured with `run.ts ceilings` and `run.ts sweep`:

| Fact                     | Value                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Largest accepted request | 64,899 input tokens (114 questions); 115 questions were rejected                                                                                                          |
| Largest accepted state   | 32,971 tokens (99,191 characters); 100,750 characters were rejected                                                                                                       |
| Rejection                | a generic `400 Invalid request`, not a `max_tokens_exceeded` message, so the CLI splits a batch on any 400                                                                |
| Rate limiting            | no 429 at 4 to 100 requests in flight, nor at 256 in flight with 2.2 million tokens outstanding                                                                           |
| Token estimate           | 3.4 characters per token for text of 64 characters or more, 2.2 for the structural rest; the billed count was within −5% to +6% of the estimate (10th to 90th percentile) |

Throughput on 1,000 pairs, 10 per request, 102 requests:

| In flight | Wall time | Mean latency | Requests/s | Tokens/s |
| --------: | --------: | -----------: | ---------: | -------: |
|         4 |    29.5 s |     1,124 ms |        3.5 |   75,000 |
|         8 |    15.4 s |     1,174 ms |        6.6 |  144,000 |
|        16 |     8.2 s |     1,176 ms |       12.4 |  269,000 |
|        32 |     5.1 s |     1,340 ms |       20.0 |  434,000 |
|        64 |     3.3 s |     1,505 ms |       30.6 |  665,000 |
|       100 |     3.0 s |     1,949 ms |       33.7 |  732,000 |

Latency stays near one second up to 16 in flight and rises after; 32 is the
default because it is on the flat part of the curve with room to halve after
a rate limit. A single pair costs about 700 ms alone; a request with 60 pairs
costs about 2 s.

## Question form

The harness has three forms of the same four questions:

- **long**: the criteria of each score level and each yes/no question are
  written out in every question, and the two declarations (file path, leading
  comment, code) travel inside the question;
- **compact**: the criteria are defined once in the state and each question
  only refers to them;
- **state**: the code of every pair is placed in the state and each question
  refers to a pair by id.

Agreement with a solo run (one pair per request, long form) over the same
pairs. "Within 0.25" is the share of pairs whose scores differ by less than
0.25; "level agree" compares the rounded 0–3 level; "flips" is the share that
changes sides of the 1.9 cutoff.

| Arm                             | Pairs | Mean abs. diff. |   Bias | Within 0.25 | Level agree | Flips at 1.9 | Shape agree | Spearman |
| ------------------------------- | ----: | --------------: | -----: | ----------: | ----------: | -----------: | ----------: | -------: |
| solo pass 2 (noise floor)       | 8,253 |           0.055 |  0.000 |       0.999 |       0.961 |        0.022 |       0.964 |    0.979 |
| solo, `refactor` question alone | 8,253 |           0.054 | +0.002 |       0.999 |       0.961 |        0.023 |           — |    0.979 |
| long, batched to 10k tokens     | 1,000 |           0.053 | −0.001 |       0.998 |       0.974 |        0.021 |       0.961 |    0.980 |
| long, batched to 20k tokens     | 1,000 |           0.055 | +0.001 |       0.997 |       0.965 |        0.021 |       0.958 |    0.978 |
| long, batched to 40k tokens     | 8,253 |           0.055 |  0.000 |       0.999 |       0.963 |        0.023 |       0.963 |    0.979 |
| long, batched to 60k tokens     | 1,000 |           0.055 | −0.002 |       0.998 |       0.972 |        0.024 |       0.965 |    0.980 |
| long, 40k, batches reshuffled   | 1,000 |           0.055 |  0.000 |       1.000 |       0.966 |        0.030 |       0.967 |    0.980 |
| long, 40k, comments removed     | 1,000 |           0.078 | +0.032 |       0.953 |       0.952 |        0.030 |       0.946 |    0.961 |
| long, 40k, file paths hidden    | 1,000 |           0.569 | +0.476 |       0.534 |       0.532 |        0.408 |       0.912 |    0.714 |
| compact, 40k                    | 8,253 |           0.242 | −0.040 |       0.607 |       0.792 |        0.053 |       0.878 |    0.736 |
| state, 40k                      | 1,000 |           0.263 | +0.049 |       0.538 |       0.748 |        0.078 |       0.873 |    0.726 |

What this decided:

- **Batching is free.** At every budget from 10k to 60k tokens the batched
  answers are as close to a solo run as a second solo run is. There is no
  position effect either: in fixed and reshuffled batches the mean deviation
  of the first, middle, and last third of a request is under 0.002. The CLI
  packs 64 pairs or 50,000 estimated tokens per request, under the 65,536
  ceiling with the estimate's error margin.
- **The other questions do not disturb the score.** Asking `refactor` alone
  gives the same scores as asking all four, so the shape, logic, and concept
  questions ride along at no cost in agreement.
- **The long form stays.** Defining the criteria once in the state costs 19%
  fewer tokens per pair but only 61% of pairs stay within 0.25 of the solo
  score; the rank correlation drops from 0.98 to 0.74. Putting the code in
  the state costs 69% fewer tokens and degrades further. Both forms are also
  noisier with themselves (pass-to-pass 0.073 and 0.079 against 0.053).
- **File paths are the strongest context.** Hiding them inflates scores by
  0.48 on average and flips 41% of pairs across the cutoff; the paths are what
  tells Jev that two locale files or a `compat` variant are kept apart on
  purpose. Removing the leading comments moves scores by 0.03 and is not
  worth the saving.

Cost per pair by form (input tokens, including the state repeated in every
request):

| Arm                    | Pairs per request | Tokens per pair | Latency per request |
| ---------------------- | ----------------: | --------------: | ------------------: |
| solo, four questions   |                 1 |           2,585 |              774 ms |
| solo, `refactor` alone |                 1 |             972 |              658 ms |
| long, 40k budget       |              16.6 |           2,230 |            1,517 ms |
| long, 60k budget       |              24.4 |           2,195 |            2,090 ms |
| compact, 40k budget    |              22.1 |           1,800 |            1,727 ms |
| state, 40k budget      |              20.4 |             684 |            1,176 ms |

## Stability across passes

The same pairs asked again in fresh requests:

| Arm                      | Pairs | Passes | Spread mean | Median |       p90 |       Max | Shape changed | Flip rate at 1.9 |
| ------------------------ | ----: | -----: | ----------: | -----: | --------: | --------: | ------------: | ---------------: |
| solo                     | 8,253 |      3 |       0.082 |   0.07 |      0.14 |      0.36 |         0.054 |            0.033 |
| long, 40k, fixed batches | 1,000 |      5 |       0.110 |   0.10 |      0.18 |      0.43 |         0.087 |            0.045 |
| long, 40k, reshuffled    | 1,000 |      5 |       0.110 |   0.10 |      0.18 |      0.40 |         0.081 |            0.050 |
| long, 10k to 60k         | 1,000 |      2 | 0.053–0.055 |   0.04 | 0.11–0.12 | 0.24–0.33 |   0.037–0.047 |      0.017–0.023 |

Flips happen only near the cutoff. In the three solo passes, 270 of the 2,285
pairs within 0.25 of 1.9 changed sides (11.8%); none of the 1,010 pairs
between 0.25 and 0.5 away did, and none of the 4,958 farther away. That is
why the CLI marks the band with `~` (`--margin 0.25`) and why `--repeat`
marks with `!` exactly the pairs whose passes disagree across the cutoff.

## Distribution

Solo scores over the 8,253 pairs:

| Bin       | Pairs |
| --------- | ----: |
| 0.00–0.25 |   105 |
| 0.25–0.50 |   403 |
| 0.50–0.75 |   824 |
| 0.75–1.00 |   880 |
| 1.00–1.25 | 2,229 |
| 1.25–1.50 |   756 |
| 1.50–1.75 | 1,556 |
| 1.75–2.00 | 1,215 |
| 2.00–2.25 |   188 |
| 2.25–2.50 |    57 |
| 2.50–2.75 |    33 |
| 2.75–3.00 |     7 |

505 pairs (6.1%) are at or over 1.9, 285 over 2.0, 173 over 2.1, 40 over
2.5. By repository: date-fns 85 of 2,207 (3.9%), es-toolkit 71 of 596
(11.9%), remeda 17 of 165 (10.3%), zod 332 of 5,285 (6.3%). The widest gap
between neighboring scores is 0.12; the answers form a continuum, not two
clusters.

Confidence is a poor gate: its median is 0.25 and 88% of pairs are under
0.5. It is high only at the ends of the scale (mean 0.65 at level 0 and 0.64
at level 3, 0.23 and 0.22 at levels 1 and 2), so gating on it would drop most
of the middle where the decisions are.

Shapes: `extract_shared` 4,289, `remove_copy` 3,777, `derive` 187. At level 3
it is 35 copies to 5 extractions; at level 2, 1,469 copies, 1,427 extractions,
120 derivations. `same_logic` rises with the level (0.52, 0.84, 0.87, 0.97)
and so does `same_concept` (0.14, 0.41, 0.63, 0.83).

## Hand labels

132 pairs were drawn by `pick-labels.ts` as a stratified sample of the score
bins, presented without their scores, and labeled by reading the code:
`merge` when a careful reviewer would ask for one shared implementation,
`keep` when the reviewer would let it pass, with a shape for every merge. 30
merges, 102 keeps. The labels and their notes are in
`docs/measurements/labels/labels.json`.

Solo scores against the labels:

| Cutoff | Precision | Recall | Accuracy |
| -----: | --------: | -----: | -------: |
|    1.5 |      0.45 |   1.00 |     0.73 |
|    1.9 |      0.58 |   0.87 |     0.83 |
|    2.0 |      0.59 |   0.87 |     0.83 |
|    2.1 |      0.64 |   0.83 |     0.86 |
|    2.5 |      0.73 |   0.53 |     0.85 |

- AUC of the score 0.93; of `same_logic` 0.74; of `same_concept` 0.74.
- The classes do not separate: the lowest merge scores 1.74 and the highest
  keep 2.71. The cutoff that maximizes true positives net of false positives
  and misses is 2.11; a 5-fold hold-out over the labels gives an accuracy of
  0.82 with fold cutoffs from 1.74 to 2.13. The default stays at 1.9 because
  the fitted value is not stable across folds and the misses cost more to a
  user than the extra borderline pairs, which carry the `~` flag.
- Requiring `same_logic` or `same_concept` above 0.5 or 0.7 in addition to
  the score leaves precision at 0.58 to 0.59: the extra questions describe a
  pair but do not sharpen the decision.
- Confidence under 0.5 marks a weaker band: of the 45 pairs reported at 1.9,
  20 are under 0.5 with precision 0.40, against 0.72 for the other 25. The
  band is worth a flag (`?`) and not a filter, because 8 of the 20 are real
  merges.
- The shape agrees with the label for 20 of the 30 merges (67%). Every pair
  labeled `remove_copy` came back `remove_copy`; 7 of the 18 labeled
  `extract_shared` came back `remove_copy`.
- The mean of three passes changes none of these numbers by more than 0.01.

Of the 19 false positives at 1.9, all but three are repository conventions:
zod locale files and its frozen v3 tree next to v4, es-toolkit's `compat`
variants of the main functions, remeda's mirror-image types (`find` and
`findLast`, `startsWith` and `endsWith`).

## A conventions note

A note describing those conventions (`docs/measurements/cli/conventions.txt`,
covering all four repositories in one paragraph) was sent as
`repository_conventions` in the state, on the labeled pairs, three passes
each, decided on the mean:

|                  | Precision | Recall | Accuracy | Shape agreement |
| ---------------- | --------: | -----: | -------: | --------------: |
| Without the note |      0.60 |   0.90 |     0.84 |            0.67 |
| With the note    |      0.88 |   0.73 |     0.92 |            0.90 |

The note lowers scores by 0.50 on average over the labeled set. The eight
misses it causes are pairs near a sentence that is broader than intended:
"every function is its own module" also covers the helper that two functions
should share. The same note run through the finished CLI on each whole
repository:

| Repository | Reported without note | Reported with note | Precision / recall at 1.9 without | With        |
| ---------- | --------------------: | -----------------: | --------------------------------- | ----------- |
| date-fns   |                    81 |                 63 | 1.00 / 0.92                       | 1.00 / 0.85 |
| es-toolkit |                    72 |                 31 | 0.53 / 0.89                       | 0.73 / 0.89 |
| remeda     |                    16 |                  1 | 0.50 / 0.60                       | — / 0.00    |
| zod        |                   317 |                 55 | 0.23 / 1.00                       | 1.00 / 1.00 |

On zod the note removes every false positive among the labels; on remeda it
removes every true positive as well, because the note's remeda sentence
generalized from mirror-image types to the whole module. A note should name
the specific things that are kept apart, and `--calibrate --labels` shows
what it did.

## The finished CLI on the corpora

`similarity-ts-jev` 0.2.0 with its defaults (32 in flight, 64 pairs or
50,000 tokens per request, two retries), one pass:

| Repository | Files | Pairs | Reported | Families | Requests | Input tokens | Cost at $0.042/M |   Wall | Retries / splits | `--dry-run` estimate |
| ---------- | ----: | ----: | -------: | -------: | -------: | -----------: | ---------------: | -----: | ---------------- | -------------------- |
| date-fns   | 1,104 | 2,207 |       81 |       62 |      108 |    5,155,281 |            $0.22 |  8.0 s | 0 / 0            | +1.4%                |
| es-toolkit |   848 |   596 |       72 |       59 |       43 |    1,905,093 |            $0.08 |  4.6 s | 0 / 1            | +0.4%                |
| remeda     |   225 |   165 |       16 |       16 |       12 |      495,743 |            $0.02 |  3.2 s | 0 / 0            | +4.9%                |
| zod        |   134 | 5,285 |      317 |      117 |      237 |   10,738,783 |            $0.45 | 19.8 s | 7 / 0            | +3.3%                |

The one split on es-toolkit was a batch the gateway rejected and the CLI
asked again in two halves; the seven retries on zod were transient server
errors, each answered on the next attempt. No pair was left unjudged.

With `--repeat 3` (the first pass answered from the cache):

| Repository | Reported by the mean | Marked `!` | Spread mean / p90 | Families |
| ---------- | -------------------: | ---------: | ----------------- | -------: |
| date-fns   |                   82 |         13 | 0.07 / 0.14       |       61 |
| es-toolkit |                   72 |         15 | 0.08 / 0.15       |       61 |
| remeda     |                   16 |          2 | 0.06 / 0.12       |       16 |
| zod        |                  284 |        240 | 0.08 / 0.15       |      116 |

zod's scores cluster around the cutoff (1,955 of its 5,285 pairs are within
0.25 of 1.9), so a single pass reports 33 pairs that the three-pass mean does
not, and a quarter of a pass's reported pairs are unstable. On the other
three repositories the mean changes the list by at most one pair.

Labeled accuracy of these runs, single pass, at 1.9:

| Repository | Labels (merge / keep) | Precision | Recall | Accuracy |  AUC | Hold-out accuracy |
| ---------- | --------------------- | --------: | -----: | -------: | ---: | ----------------: |
| date-fns   | 32 (13 / 19)          |      1.00 |   0.92 |     0.97 | 1.00 |              0.97 |
| es-toolkit | 38 (9 / 29)           |      0.53 |   0.89 |     0.79 | 0.93 |              0.89 |
| remeda     | 30 (5 / 25)           |      0.50 |   0.60 |     0.83 | 0.90 |              0.80 |
| zod        | 32 (3 / 29)           |      0.23 |   1.00 |     0.69 | 0.91 |              0.84 |

## What did not transfer

Techniques that read well in general guidance but did not survive
measurement on this task:

- Defining the rubric once in the state and keeping each question short:
  agreement with the full form fell to 61% within 0.25 (see above).
- Putting the subject in the state and asking many questions about it: the
  same degradation, larger.
- Gating on confidence, or on a second signal such as `same_logic`: no
  precision gained, real merges lost.
- Fitting the cutoff to the labels: the fitted value moves between 1.74 and
  2.13 across folds; the classes overlap by a full point.
- A conventions note written as policy: it generalizes to neighbors and
  removes true positives. Specific exceptions work.

## Reproducing

```bash
export CORPORA_DIR=/path/to/clones RESULTS_DIR=/path/to/results
node scripts/experiments/run.ts snapshot --corpus all
node scripts/experiments/run.ts ceilings
node scripts/experiments/run.ts solo --arm all-r1 --concurrency 48
node scripts/experiments/run.ts solo --arm refactor-only --kinds refactor --concurrency 64
node scripts/experiments/run.ts batched --arm long-b40k-full --batch 200 --budget 40000 --concurrency 16
node scripts/experiments/run.ts batched --arm long-b40k-fixed --subset 1000 --batch 200 --budget 40000 --repeat 5 --concurrency 16
node scripts/experiments/run.ts batched --arm long-b40k-nopaths --subset 1000 --batch 200 --budget 40000 --no-paths --repeat 2
node scripts/experiments/run.ts batched --arm compact-b40k-full --batch 200 --budget 40000 --variant compact
node scripts/experiments/run.ts batched --arm state-b40k --subset 1000 --batch 40 --budget 40000 --variant state --repeat 3
node scripts/experiments/run.ts sweep --subset 1000 --batch 10 --budget 60000 --arm b10 --concurrency 4,8,16,32,64,100
node scripts/experiments/pick-labels.ts
node scripts/experiments/export-labels.ts
node scripts/experiments/analyze.ts --labels "$RESULTS_DIR/labels/labels.json" --out "$RESULTS_DIR/summary.json"
```

`run.ts --help` lists every option. The snapshot is reused by every later
arm; after updating a corpus, run `run.ts snapshot --refresh` so the pairs are
detected again. Each request is appended to `$RESULTS_DIR/requests.jsonl`
with its estimate, billed tokens, latency, and status. The corpora were cloned from `date-fns/date-fns`, `toss/es-toolkit`,
`remeda/remeda`, and `colinhacks/zod` at the commits above.
