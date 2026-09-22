#!/usr/bin/env node
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalyzerMode } from "@kongyo2/similarity-ts";
import { TypeSafeClient, TypeSafeError } from "@typesafe-ai/sdk";
import { Command, CommanderError, Option } from "commander";
import { FileJudgeCache } from "./cache.ts";
import { calibrate, formatCalibration } from "./calibrate.ts";
import type { Labels } from "./calibrate.ts";
import { DEFAULT_MARGIN, DEFAULT_MIN_SCORE, DEFAULT_UNSURE_BELOW } from "./decide.ts";
import { detect } from "./detect.ts";
import { formatJsonReport, formatPrettyReport, formatStats } from "./format.ts";
import { judgeReport, orderPairs, readSnippets } from "./index.ts";
import { DEFAULT_CONCURRENCY, DEFAULT_RETRIES, USD_PER_MILLION_INPUT_TOKENS } from "./judge.ts";
import type { JudgeClient } from "./judge.ts";
import { DEFAULT_BUDGET_TOKENS, DEFAULT_PAIRS_PER_REQUEST, batchPairs, estimateTokens, buildState } from "./questions.ts";
import { buildRecord, loadRecord, replayRecord, saveRecord } from "./record.ts";
import type { JevReport } from "./types.ts";

export interface CliIO {
  log: (message: string) => void;
  error: (message: string) => void;
}

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };
const MODES: readonly AnalyzerMode[] = ["functions", "types", "classes", "overlap"];
const DEFAULT_MODES: AnalyzerMode[] = ["functions", "types", "classes"];

interface RawOptions {
  modes: string;
  threshold: string;
  minLines: string;
  minTokens?: string;
  sizePenalty: boolean;
  sameFileOnly: boolean;
  crossFileOnly: boolean;
  extensions: string;
  exclude: string[];
  typesOnly: "all" | "interface" | "type";
  allowCrossKind: boolean;
  typeLiterals: boolean;
  overlapMinWindow: string;
  overlapMaxWindow: string;
  overlapSizeTolerance: string;
  fallowNear: boolean;
  fallowMinTokens?: string;
  fallowMinLines?: string;
  minScore: string;
  unsureBelow: string;
  margin: string;
  all: boolean;
  maxPairs?: string;
  repeat: string;
  conventions?: string;
  concurrency: string;
  pairsPerRequest: string;
  budgetTokens: string;
  retries: string;
  model?: string;
  baseUrl?: string;
  cache?: string;
  timeout: string;
  dryRun: boolean;
  record?: string;
  replay?: string;
  calibrate: boolean;
  labels?: string;
  stats: boolean;
  format: "pretty" | "json";
  output?: string;
  failOnWarnings: boolean;
  failOnDuplicates: boolean;
}

const DECIMAL = /^-?(?:\d+|\d*\.\d+)$/;

function number(value: string, field: string, min?: number, max?: number): number {
  const raw = value.trim();
  if (!DECIMAL.test(raw)) throw new Error(`${field} must be a number`);
  const parsed = Number(raw);
  if (min !== undefined && parsed < min) throw new Error(`${field} must be at least ${min}`);
  if (max !== undefined && parsed > max) throw new Error(`${field} must be at most ${max}`);
  return parsed;
}

function integer(value: string, field: string, min = 1): number {
  const parsed = number(value, field, min);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseModes(value: string): AnalyzerMode[] {
  const modes = list(value);
  if (modes.length === 0) return DEFAULT_MODES;
  for (const mode of modes) {
    if (!MODES.includes(mode as AnalyzerMode)) throw new Error(`unknown mode "${mode}" (expected ${MODES.join(", ")})`);
  }
  return [...new Set(modes as AnalyzerMode[])];
}

function buildProgram(io: CliIO): Command {
  const program = new Command();
  program
    .name("similarity-ts-jev")
    .description("Similar-code detection (similarity-ts and fallow, always both), filtered by Jev down to the pairs worth refactoring")
    .version(packageJson.version)
    .argument("[paths...]", "Files and directories to analyze (not needed with --replay)")
    .option("--modes <list>", "Comma-separated modes: functions,types,classes,overlap", DEFAULT_MODES.join(","))
    .option("-t, --threshold <number>", "Similarity threshold (0-1)", "0.8")
    .option("--min-lines <number>", "Minimum function line count", "3")
    .option("--min-tokens <number>", "Minimum function size in AST nodes (replaces the line gate)")
    .option("--no-size-penalty", "Disable line-count size penalty for function mode")
    .option("--same-file-only", "Only compare symbols from the same file", false)
    .option("--cross-file-only", "Only compare symbols across different files", false)
    .option("--extensions <list>", "Comma-separated extensions", "ts,tsx,mts,cts")
    .option(
      "--exclude <pattern>",
      "Exclude glob pattern (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .addOption(new Option("--types-only <kind>", "Type mode filter").choices(["all", "interface", "type"]).default("all"))
    .option("--no-allow-cross-kind", "Disable interface <-> type alias matching")
    .option("--type-literals", "Include anonymous type literals in type mode", false)
    .option("--overlap-min-window <number>", "Overlap mode minimum token window", "8")
    .option("--overlap-max-window <number>", "Overlap mode maximum token window", "30")
    .option("--overlap-size-tolerance <number>", "Allowed segment-size ratio difference in overlap mode", "0.25")
    .option("--no-fallow-near", "Disable fallow's function-scoped near-miss clone detection")
    .option("--fallow-min-tokens <number>", "fallow: minimum token count for a clone (default: 50)")
    .option("--fallow-min-lines <number>", "fallow: minimum line count for a clone (default: 5)")
    .option("--min-score <number>", "Lowest Jev refactor score (0-3) reported as worth refactoring", String(DEFAULT_MIN_SCORE))
    .option("--unsure-below <number>", "Mark a reported pair as unsure (?) when Jev's confidence is under this (0-1)", String(DEFAULT_UNSURE_BELOW))
    .option("--margin <number>", "Mark a pair as borderline (~) when its score is within this of --min-score", String(DEFAULT_MARGIN))
    .option("--all", "Also list the pairs Jev would leave as they are", false)
    .option("--max-pairs <number>", "Judge at most this many pairs (highest similarity first)")
    .option("--repeat <number>", "Ask every pair this many times and decide on the mean score; pairs that cross --min-score between passes are marked unstable (!)", "1")
    .option("--conventions <text>", "Repository conventions a reviewer would know (what is deliberately kept separate); sent with every request")
    .option("--concurrency <number>", "Jev requests in flight at once; halved after a rate limit", String(DEFAULT_CONCURRENCY))
    .option("--pairs-per-request <number>", "At most this many pairs in one Jev request", String(DEFAULT_PAIRS_PER_REQUEST))
    .option("--budget-tokens <number>", "Estimated input tokens packed into one Jev request", String(DEFAULT_BUDGET_TOKENS))
    .option("--retries <number>", "Extra attempts per request after a rate limit, a server error, or a connection failure (on top of the SDK's own)", String(DEFAULT_RETRIES))
    .option("--model <name>", "Jev model name (default: TYPESAFE_DEFAULT_MODEL or jev-latest)")
    .option("--base-url <url>", "TypeSafe-compatible API root (default: TYPESAFE_BASE_URL or https://api.typesafe.ai)")
    .option("--cache <file>", "Record Jev's answers in this JSON file and replay them on later runs")
    .option("--timeout <ms>", "Timeout per Jev request attempt", "60000")
    .option("--dry-run", "Detect and print the pair, request, and token counts without asking Jev", false)
    .option("--record <file>", "Write every judgment and the thresholds to this file, for --replay")
    .option("--replay <file>", "Re-decide a recorded run with the current thresholds; no detection, no requests")
    .option("--calibrate", "Print the score distribution, gap, headroom, and (with --labels) precision, recall, AUC, and a hold-out fit instead of the results", false)
    .option("--labels <file>", "JSON of pair keys to true (merge) or false (keep), as scripts/verify.ts writes them; used by --calibrate")
    .option("--stats", "Print request, token, cost, and timing counts (stderr for pretty, in the document for json)", false)
    .addOption(new Option("--format <format>", "Output format").choices(["pretty", "json"]).default("pretty"))
    .option("--output <path>", "Write the report to a file")
    .option("--fail-on-warnings", "Exit with a non-zero code when the analysis emits any warning", false)
    .option("--fail-on-duplicates", "Exit with a non-zero code when Jev reports any pair worth refactoring (CI gate)", false)
    .showHelpAfterError(true);
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => io.log(text.replace(/\n$/, "")),
    writeErr: (text) => io.error(text.replace(/\n$/, "")),
  });
  return program;
}

function createClient(options: { model?: string; baseURL?: string; timeout: number }): TypeSafeClient {
  try {
    return new TypeSafeClient({
      ...(options.model !== undefined ? { defaultModel: options.model } : {}),
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      timeout: options.timeout,
      logLevel: "warn",
    });
  } catch (error) {
    if (error instanceof TypeSafeError && /api key/i.test(error.message)) {
      throw new Error(
        "TYPESAFE_API_KEY is not set. Jev needs a TypeSafe API key (https://console.typesafe.ai/keys). " +
          "For a TypeSafe-compatible gateway set TYPESAFE_BASE_URL and TYPESAFE_DEFAULT_MODEL as well, " +
          "e.g. TYPESAFE_BASE_URL=https://ai-gateway.lolipop.jp TYPESAFE_DEFAULT_MODEL=typesafe/jev-latest.",
      );
    }
    throw error;
  }
}

function lazyClient(create: () => TypeSafeClient, defaultModel: string): JudgeClient {
  let client: TypeSafeClient | undefined;
  return {
    defaultModel,
    systemOne: ((request, options) => (client ??= create()).systemOne(request, options)) as TypeSafeClient["systemOne"],
  };
}

export function exitCode(report: JevReport, gates: { failOnWarnings: boolean; failOnDuplicates: boolean }): number {
  if (report.warnings.length > 0 && (report.stats.fileCount === 0 || gates.failOnWarnings)) return 1;
  if (report.unjudged.some((pair) => pair.reason === "unreadable")) return 1;
  if (report.unjudged.some((pair) => pair.reason === "api")) return 2;
  if (gates.failOnDuplicates && report.results.length > 0) return 1;
  return 0;
}

async function readLabels(filePath: string): Promise<Labels> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  const labels: Labels = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") labels[key] = value;
    else if (typeof value === "object" && value !== null && typeof (value as { merge?: unknown }).merge === "boolean") labels[key] = (value as { merge: boolean }).merge;
    else throw new Error(`${filePath}: label for ${JSON.stringify(key)} must be true, false, or { "merge": boolean }`);
  }
  return labels;
}

export interface RunOptions {
  client?: JudgeClient;
  cwd?: string;
}

export async function runCli(argv: string[], io: CliIO = console, run: RunOptions = {}): Promise<number> {
  try {
    const program = buildProgram(io);
    program.parse(argv, { from: "user" });
    const paths = program.args.map(String);
    const raw = program.opts<RawOptions>();
    const cwd = run.cwd ?? process.cwd();

    const minScore = number(raw.minScore, "min-score", 0, 3);
    const unsureBelow = number(raw.unsureBelow, "unsure-below", 0, 1);
    const margin = number(raw.margin, "margin", 0, 3);
    const decideOptions = { minScore, unsureBelow, margin };
    const gates = { failOnWarnings: raw.failOnWarnings, failOnDuplicates: raw.failOnDuplicates };

    const emit = async (text: string): Promise<void> => {
      if (raw.output !== undefined) {
        await fs.mkdir(path.dirname(path.resolve(cwd, raw.output)), { recursive: true });
        await fs.writeFile(path.resolve(cwd, raw.output), text === "" ? "" : `${text}\n`, "utf8");
      } else if (text !== "") {
        io.log(text);
      }
    };

    const finish = async (report: JevReport, reportCwd: string): Promise<number> => {
      if (raw.calibrate) {
        const labels = raw.labels !== undefined ? await readLabels(path.resolve(cwd, raw.labels)) : undefined;
        const calibration = calibrate(report, reportCwd, labels);
        await emit(raw.format === "json" ? JSON.stringify({ calibration }, null, 2) : formatCalibration(calibration));
      } else {
        await emit(raw.format === "json" ? formatJsonReport(report, { includeRejected: raw.all, stats: raw.stats }) : formatPrettyReport(report, reportCwd, { includeRejected: raw.all }));
        if (raw.stats && raw.format !== "json") {
          io.error(formatStats(report.stats, report.thresholds, { results: report.results.length, rejected: report.rejectedCount, unjudged: report.unjudged.length }));
        }
      }
      for (const warning of report.warnings) io.error(warning.filePath ? `${warning.filePath}: ${warning.message}` : warning.message);
      for (const reason of ["unreadable", "api"] as const) {
        const failed = report.unjudged.filter((pair) => pair.reason === reason);
        if (failed.length > 0) io.error(`${failed.length} pair${failed.length === 1 ? "" : "s"} not judged: ${failed[0]!.error}`);
      }
      return exitCode(report, gates);
    };

    if (raw.replay !== undefined) {
      const record = await loadRecord(path.resolve(cwd, raw.replay));
      return await finish(replayRecord(record, decideOptions), record.cwd);
    }
    if (paths.length === 0) throw new Error("missing required argument 'paths' (or pass --replay <file>)");

    const modes = parseModes(raw.modes);
    const threshold = number(raw.threshold, "threshold", 0, 1);
    const concurrency = integer(raw.concurrency, "concurrency");
    const pairsPerRequest = integer(raw.pairsPerRequest, "pairs-per-request");
    const budgetTokens = integer(raw.budgetTokens, "budget-tokens", 1000);
    const retries = integer(raw.retries, "retries", 0);
    const repeat = integer(raw.repeat, "repeat");
    const timeout = integer(raw.timeout, "timeout");
    const maxPairs = raw.maxPairs === undefined ? undefined : integer(raw.maxPairs, "max-pairs", 0);
    if (raw.sameFileOnly && raw.crossFileOnly) throw new Error("Cannot use both --same-file-only and --cross-file-only");

    const detection = await detect({
      similarityTs: {
        paths,
        cwd,
        modes,
        threshold,
        minLines: integer(raw.minLines, "min-lines"),
        ...(raw.minTokens !== undefined ? { minTokens: integer(raw.minTokens, "min-tokens") } : {}),
        noSizePenalty: !raw.sizePenalty,
        sameFileOnly: raw.sameFileOnly,
        crossFileOnly: raw.crossFileOnly,
        extensions: list(raw.extensions).map((extension) => extension.replace(/^\./, "").toLowerCase()),
        exclude: raw.exclude,
        typesOnly: raw.typesOnly,
        allowCrossKind: raw.allowCrossKind,
        includeTypeLiterals: raw.typeLiterals,
        overlapMinWindow: integer(raw.overlapMinWindow, "overlap-min-window"),
        overlapMaxWindow: integer(raw.overlapMaxWindow, "overlap-max-window"),
        overlapSizeTolerance: number(raw.overlapSizeTolerance, "overlap-size-tolerance", 0, 1),
      },
      fallow: {
        near: raw.fallowNear,
        ...(raw.fallowMinTokens !== undefined ? { minTokens: integer(raw.fallowMinTokens, "fallow-min-tokens") } : {}),
        ...(raw.fallowMinLines !== undefined ? { minLines: integer(raw.fallowMinLines, "fallow-min-lines") } : {}),
      },
    });

    if (raw.dryRun) {
      const { snippets, unreadable } = await readSnippets(orderPairs(detection.pairs), { cwd, ...(maxPairs !== undefined ? { maxPairs } : {}) });
      const batches = batchPairs(snippets, { pairsPerRequest, budgetTokens });
      const stateTokens = estimateTokens(buildState(path.basename(path.resolve(cwd)), raw.conventions !== undefined ? { conventions: raw.conventions } : {}));
      const tokens = (snippets.reduce((sum, s) => sum + s.tokens, 0) + batches.length * stateTokens) * repeat;
      const requests = batches.length * repeat;
      io.log(`${snippets.length} pairs, ${requests} requests, ${tokens} tokens, ~$${((tokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS).toFixed(4)}${repeat > 1 ? ` (${repeat} passes)` : ""}`);
      for (const warning of detection.warnings) io.error(warning.filePath ? `${warning.filePath}: ${warning.message}` : warning.message);
      const failed = unreadable.filter((pair) => pair.reason === "unreadable");
      if (failed.length > 0) io.error(`${failed.length} pair${failed.length === 1 ? "" : "s"} not judged: ${failed[0]!.error}`);
      if (detection.warnings.length > 0 && (detection.stats.fileCount === 0 || raw.failOnWarnings)) return 1;
      return failed.length > 0 ? 1 : 0;
    }

    const cache = raw.cache !== undefined ? await FileJudgeCache.load(path.resolve(cwd, raw.cache)) : undefined;
    if (cache !== undefined && cache.dropped > 0) io.error(`${raw.cache}: ${cache.dropped} entries from an older version were dropped; the answers will be asked again`);
    const client =
      run.client ??
      lazyClient(
        () =>
          createClient({
            ...(raw.model !== undefined ? { model: raw.model } : {}),
            ...(raw.baseUrl !== undefined ? { baseURL: raw.baseUrl } : {}),
            timeout,
          }),
        raw.model ?? (process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest"),
      );
    const judged = await judgeReport(detection, client, {
      cwd,
      ...decideOptions,
      concurrency,
      pairsPerRequest,
      budgetTokens,
      retries,
      repeat,
      ...(raw.conventions !== undefined ? { conventions: raw.conventions } : {}),
      ...(maxPairs !== undefined ? { maxPairs } : {}),
      ...(raw.model !== undefined ? { model: raw.model } : {}),
      ...(cache !== undefined ? { cache } : {}),
    });
    if (cache !== undefined && raw.cache !== undefined) await cache.save(path.resolve(cwd, raw.cache));
    if (raw.record !== undefined) await saveRecord(buildRecord(judged, cwd), path.resolve(cwd, raw.record));
    return await finish(judged, cwd);
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function isCliEntrypoint(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) return false;
  let resolved = argvPath;
  try {
    resolved = realpathSync(argvPath);
  } catch {
  }
  return path.resolve(fileURLToPath(moduleUrl)) === path.resolve(resolved);
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
