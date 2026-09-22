# Changelog

## 0.2.0

Every default in this release was chosen from measurements: 61,371 Jev
requests over 8,253 similar pairs from date-fns, es-toolkit, remeda, and zod,
plus 132 hand-labeled pairs. The write-up is in `docs/measurements.md`.

### Added

- A fourth question per pair, `shape`: the single change a reviewer would ask
  for once the two declarations are merged. It is printed as `copy` (delete one
  copy), `derive` (express one in terms of the other), or `extract` (pull a
  shared helper out of both), and comes back as `shape` in `--format json`.
- Flags after the score in the pretty output: `?` when Jev's confidence is under
  `--unsure-below` (default 0.5), `~` when the score is within `--margin`
  (default 0.25) of `--min-score`, and `!` when the passes of a `--repeat` run
  disagree across the cutoff. None of them changes what is reported; the labeled
  corpus showed confidence is worth a warning but not a gate.
- `--repeat <n>`: ask every pair n times and decide on the mean score. The
  pass-to-pass spread is reported per pair (`passes` in JSON); a pair whose
  passes did not all answer is left unjudged rather than decided on a partial
  mean.
- `--conventions <text>`: a note on what this repository keeps separate on
  purpose, sent with every request. On the labeled corpus it moved precision
  from 0.60 to 0.88 at the cost of recall (0.90 to 0.73).
- `--record <file>` and `--replay <file>`: keep every judgment of a run with
  its thresholds and re-decide it later, under the recorded thresholds or
  other ones, without detection or requests.
- `--calibrate` and `--labels <file>`: print the score histogram, the widest
  gap, the headroom around the cutoff, the confidence quantiles, and, with
  labels, precision, recall, AUC, a fitted cutoff, and a 5-fold hold-out.
- `--stats`: request, token, cost, retry, and timing counts (stderr for pretty,
  `thresholds` and `stats` in the JSON document), for results and for
  `--calibrate` alike.
- `--budget-tokens` and `--retries`; an adaptive limiter that halves the
  concurrency after a rate limit and recovers one slot per success; a request
  the gateway rejects is split in half and asked again.
- `scripts/experiments/`: the measurement harness (corpus snapshots, solo and
  batched arms, ceilings, concurrency sweep, label sampling, analysis).
- `scripts/proxy.ts`: a local TypeSafe-compatible endpoint backed by the SDK,
  for tools that need a plain HTTP target.

### Changed

- Requests go through `@typesafe-ai/sdk` directly; the previous fetch adapter
  and its proxy are gone.
- Defaults from the sweep and the ceiling probes: `--concurrency 32`
  (was 4), `--pairs-per-request 64` (was 40), 50,000 estimated tokens per
  request, and a request ceiling of 65,536 tokens. Batch size does not move the
  answers at any budget that was tried.
- Every question repeats the file path and the leading comment of both
  declarations; removing the paths inflates scores by 0.48 on average.
- Pretty lines are `score`, flag, shape, then the two locations; families of
  three or more still print one member per line.
- `--format json` results gain `shape`, `shapeConfidence`, `unsure`, and
  `borderline` (plus `unstable` and `passes` under `--repeat`); families gain
  `shape`, `unsure`, and `borderline`.
- The cache file format is version 2; a file from 0.1 is read as empty, its
  answers are asked again, and the file is rewritten.
- Library: `JevReport.rejected` is always present; `Judgment` carries the shape
  and, after `--repeat`, the passes; `Verdict` carries the flags; `judgePairs`
  accepts `repeat`, `retries`, `budgetTokens`, and `conventions`.

### Fixed

- A request that is too large for the gateway is detected from any 400
  response, not only from a `max_tokens_exceeded` message, and is split rather
  than dropped.

## 0.1.0

First release: `similarity-ts` and `fallow` findings merged into one list of
pairs, each judged by Jev with `refactor`, `same_logic`, and `same_concept`,
reported as families with a `--min-score` cutoff, a replayable `--cache`, and a
`--dry-run` estimate.
