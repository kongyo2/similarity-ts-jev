import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { CloneGroupFinding, CloneInstance, DupesOutput, ErrorOutput } from "fallow/types";
import type { AnalyzerLocation, DetectedPair } from "./types.ts";

export type FallowMode = "strict" | "mild" | "weak" | "semantic";

export const FALLOW_MODES: readonly FallowMode[] = Object.freeze(["strict", "mild", "weak", "semantic"]);

export const FRAGMENT_KIND = "fragment";

export interface FallowOptions {
  cwd?: string;
  paths?: string[];
  exclude?: string[];
  near?: boolean;
  minTokens?: number;
  minLines?: number;
  exec?: (args: string[], cwd: string) => Promise<{ stdout: string; code: number }>;
}

export interface FallowResult {
  pairs: DetectedPair[];
  cloneGroups: number;
  cloneInstances: number;
  elapsedMs: number;
}

export class FallowError extends Error {
  constructor(message: string) {
    super(`fallow dupes did not run: ${message}`);
    this.name = "FallowError";
  }
}

const execFileAsync = promisify(execFile);

export async function runFallowBinary(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  const launcher = createRequire(import.meta.url).resolve("fallow/bin/fallow");
  try {
    const { stdout } = await execFileAsync(process.execPath, [launcher, ...args], { cwd, maxBuffer: 1024 * 1024 * 512, windowsHide: true });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number | string; message?: string };
    if (typeof failure.stdout === "string" && typeof failure.code === "number") return { stdout: failure.stdout, code: failure.code };
    throw error;
  }
}

export async function runFallow(options: FallowOptions = {}): Promise<FallowResult> {
  const started = Date.now();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const exec = options.exec ?? runFallowBinary;
  const outputs = await Promise.all(FALLOW_MODES.map((mode) => runMode(exec, cwd, mode, options)));

  const keep = instanceFilter(cwd, options.paths, options.exclude);
  const pairs: DetectedPair[] = [];
  const byFiles = new Map<string, DetectedPair[]>();
  let instances = 0;
  for (const output of outputs) {
    for (const group of output.clone_groups ?? []) {
      const kept = group.instances.filter(keep);
      if (kept.length < 2) continue;
      const pair = toPair(group, kept, cwd);
      const key = fileKey(pair);
      const known = (byFiles.get(key) ?? []).find((candidate) => samePair(candidate, pair));
      if (known !== undefined) {
        absorb(known, pair);
        continue;
      }
      pairs.push(pair);
      byFiles.set(key, [...(byFiles.get(key) ?? []), pair]);
      instances += kept.length;
    }
  }
  return { pairs, cloneGroups: pairs.length, cloneInstances: instances, elapsedMs: Date.now() - started };
}

async function runMode(exec: NonNullable<FallowOptions["exec"]>, cwd: string, mode: FallowMode, options: FallowOptions): Promise<DupesOutput> {
  const args = ["dupes", "--root", cwd, "--mode", mode, "--format", "json", "--quiet", "--no-fragments"];
  if (options.near ?? true) args.push("--near");
  if (options.minTokens !== undefined) args.push("--min-tokens", String(options.minTokens));
  if (options.minLines !== undefined) args.push("--min-lines", String(options.minLines));
  try {
    const { stdout, code } = await exec(args, cwd);
    const parsed = parseJson(stdout);
    if (parsed === undefined) throw new FallowError(`${mode} mode: exit code ${code} without JSON output`);
    if (isErrorOutput(parsed)) throw new FallowError(`${mode} mode: ${parsed.message ?? `exit code ${code}`}`);
    if (code > 1) throw new FallowError(`${mode} mode: exit code ${code}`);
    return parsed as DupesOutput;
  } catch (error) {
    if (error instanceof FallowError) throw error;
    throw new FallowError(`${mode} mode: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function absorb(known: DetectedPair, other: DetectedPair): void {
  const members = unionLocations(known.instances ?? [known.left, known.right], other.instances ?? [other.left, other.right]);
  if (members.length > 2) known.instances = members;
  known.similarity = Math.max(known.similarity, other.similarity);
}

export function unionLocations(base: AnalyzerLocation[], extra: AnalyzerLocation[]): AnalyzerLocation[] {
  const members = [...base];
  for (const location of extra) {
    if (!members.some((member) => overlaps(member, location))) members.push(location);
  }
  return members;
}

function fileKey(pair: DetectedPair): string {
  return [pair.left.filePath, pair.right.filePath].map((p) => path.resolve(p)).sort().join("|");
}

export function samePair(x: DetectedPair, y: DetectedPair): boolean {
  const straight = overlaps(x.left, y.left) && overlaps(x.right, y.right);
  const crossed = overlaps(x.left, y.right) && overlaps(x.right, y.left);
  return straight || crossed;
}

export function overlaps(a: AnalyzerLocation, b: AnalyzerLocation): boolean {
  if (path.resolve(a.filePath) !== path.resolve(b.filePath)) return false;
  const shared = Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1;
  if (shared <= 0) return false;
  const longer = Math.max(a.endLine - a.startLine + 1, b.endLine - b.startLine + 1);
  return shared * 2 >= longer;
}

function toPair(group: CloneGroupFinding, instances: CloneInstance[], cwd: string): DetectedPair {
  const locations = instances.map((instance) => toLocation(instance, group, cwd));
  const [left, right] = mostDistant(locations);
  return {
    mode: "overlap",
    similarity: group.similarity ?? 1,
    left,
    right,
    ...(locations.length > 2 ? { instances: locations } : {}),
  };
}

function toLocation(instance: CloneInstance, group: CloneGroupFinding, cwd: string): AnalyzerLocation {
  return {
    filePath: path.resolve(cwd, instance.file),
    startLine: instance.start_line,
    endLine: instance.end_line,
    symbolName: group.suggested_name ?? "(fragment)",
    kind: FRAGMENT_KIND,
  };
}

function mostDistant(locations: AnalyzerLocation[]): [AnalyzerLocation, AnalyzerLocation] {
  const first = locations[0]!;
  const other = locations.find((location) => location.filePath !== first.filePath);
  if (other !== undefined) return [first, other];
  let farthest = locations[1]!;
  for (const location of locations.slice(2)) {
    if (Math.abs(location.startLine - first.startLine) > Math.abs(farthest.startLine - first.startLine)) farthest = location;
  }
  return [first, farthest];
}

function instanceFilter(cwd: string, paths: string[] | undefined, exclude: string[] | undefined): (instance: CloneInstance) => boolean {
  const roots = (paths ?? []).map((p) => path.resolve(cwd, p));
  const excludes = exclude ?? [];
  return (instance) => {
    const absolute = path.resolve(cwd, instance.file);
    if (roots.length > 0 && !roots.some((root) => isInside(root, absolute))) return false;
    if (excludes.length > 0) {
      const relative = path.relative(cwd, absolute).split(path.sep).join("/");
      if (excludes.some((pattern) => matchesGlob(relative, pattern))) return false;
    }
    return true;
  };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function matchesGlob(relative: string, pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const withGlob = path.posix as unknown as { matchesGlob?: (target: string, glob: string) => boolean };
  if (typeof withGlob.matchesGlob === "function") {
    return withGlob.matchesGlob(relative, normalized) || withGlob.matchesGlob(relative, `**/${normalized}`);
  }
  return relative.includes(normalized.replace(/\*+/g, ""));
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

function isErrorOutput(value: unknown): value is ErrorOutput & { message?: string } {
  return typeof value === "object" && value !== null && (value as { error?: unknown }).error === true;
}
