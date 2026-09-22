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
import { DEFAULT_MIN_SCORE } from "./decide.ts";
import { detect } from "./detect.ts";
import { formatJsonReport, formatPrettyReport } from "./format.ts";
import { judgeReport, orderPairs, readSnippets } from "./index.ts";
import type { JudgeClient } from "./judge.ts";
import type { JevReport } from "./types.ts";
import { batchPairs } from "./questions.ts";

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
  all: boolean;
  maxPairs?: string;
  concurrency: string;
  pairsPerRequest: string;
  model?: string;
  baseUrl?: string;
  cache?: string;
  timeout: string;
  dryRun: boolean;
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
    .argument("<paths...>", "Files and directories to analyze")
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
    .option("--min-score <number>", `Lowest Jev refactor score (0-3) reported as worth refactoring`, String(DEFAULT_MIN_SCORE))
    .option("--all", "Also list the pairs Jev would leave as they are", false)
    .option("--max-pairs <number>", "Judge at most this many pairs (highest similarity first)")
    .option("--concurrency <number>", "Jev requests in flight at once", "4")
    .option("--pairs-per-request <number>", "Pairs packed into one Jev request", "40")
    .option("--model <name>", "Jev model name (default: TYPESAFE_DEFAULT_MODEL or jev-latest)")
    .option("--base-url <url>", "TypeSafe-compatible API root (default: TYPESAFE_BASE_URL or https://api.typesafe.ai)")
    .option("--cache <file>", "Record Jev's answers in this JSON file and replay them on later runs")
    .option("--timeout <ms>", "Timeout per Jev request attempt", "60000")
    .option("--dry-run", "Detect and print the pair, request, and token counts without asking Jev", false)
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

function lazyClient(create: () => TypeSafeClient): JudgeClient {
  let client: TypeSafeClient | undefined;
  return {
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

    const modes = parseModes(raw.modes);
    const threshold = number(raw.threshold, "threshold", 0, 1);
    const minScore = number(raw.minScore, "min-score", 0, 3);
    const concurrency = integer(raw.concurrency, "concurrency");
    const pairsPerRequest = integer(raw.pairsPerRequest, "pairs-per-request");
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
      const { snippets } = await readSnippets(orderPairs(detection.pairs), { cwd, ...(maxPairs !== undefined ? { maxPairs } : {}) });
      const batches = batchPairs(snippets, { pairsPerRequest });
      const tokens = snippets.reduce((sum, s) => sum + s.tokens, 0);
      io.log(`${snippets.length} pairs, ${batches.length} requests, ${tokens} tokens`);
      for (const warning of detection.warnings) io.error(warning.filePath ? `${warning.filePath}: ${warning.message}` : warning.message);
      return detection.warnings.length > 0 && (detection.stats.fileCount === 0 || raw.failOnWarnings) ? 1 : 0;
    }

    const cache = raw.cache !== undefined ? await FileJudgeCache.load(path.resolve(cwd, raw.cache)) : undefined;
    const client =
      run.client ??
      lazyClient(() =>
        createClient({
          ...(raw.model !== undefined ? { model: raw.model } : {}),
          ...(raw.baseUrl !== undefined ? { baseURL: raw.baseUrl } : {}),
          timeout,
        }),
      );
    const judged = await judgeReport(detection, client, {
      cwd,
      includeRejected: raw.all,
      minScore,
      concurrency,
      pairsPerRequest,
      ...(maxPairs !== undefined ? { maxPairs } : {}),
      ...(raw.model !== undefined ? { model: raw.model } : {}),
      ...(cache !== undefined ? { cache } : {}),
    });
    if (cache !== undefined && raw.cache !== undefined) await cache.save(path.resolve(cwd, raw.cache));

    const rendered = raw.format === "json" ? formatJsonReport(judged) : formatPrettyReport(judged, cwd);
    if (raw.output !== undefined) {
      await fs.mkdir(path.dirname(path.resolve(cwd, raw.output)), { recursive: true });
      await fs.writeFile(path.resolve(cwd, raw.output), rendered === "" ? "" : `${rendered}\n`, "utf8");
    } else if (rendered !== "") {
      io.log(rendered);
    }

    for (const warning of judged.warnings) io.error(warning.filePath ? `${warning.filePath}: ${warning.message}` : warning.message);
    for (const reason of ["unreadable", "api"] as const) {
      const failed = judged.unjudged.filter((pair) => pair.reason === reason);
      if (failed.length > 0) io.error(`${failed.length} pair${failed.length === 1 ? "" : "s"} not judged: ${failed[0]!.error}`);
    }
    return exitCode(judged, { failOnWarnings: raw.failOnWarnings, failOnDuplicates: raw.failOnDuplicates });
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
