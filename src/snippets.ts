import fs from "node:fs/promises";
import path from "node:path";
import type { AnalyzerLocation } from "@kongyo2/similarity-ts";
import type { PairMode, Snippet } from "./types.ts";

export interface SnippetOptions {
  cwd?: string;
  maxCodeChars?: number;
  maxDocChars?: number;
  singleLineExtension?: number;
  readFile?: (filePath: string) => Promise<string>;
}

const LINE_COMMENT = /^\s*\/\//;
const BLOCK_END = /\*\/\s*$/;
const BLOCK_START = /\/\*/;

export class SnippetReader {
  readonly #cwd: string;
  readonly #maxCodeChars: number;
  readonly #maxDocChars: number;
  readonly #singleLineExtension: number;
  readonly #readFile: (filePath: string) => Promise<string>;
  readonly #files = new Map<string, Promise<string[]>>();

  constructor(options: SnippetOptions = {}) {
    this.#cwd = options.cwd ?? process.cwd();
    this.#maxCodeChars = options.maxCodeChars ?? 6000;
    this.#maxDocChars = options.maxDocChars ?? 1500;
    this.#singleLineExtension = options.singleLineExtension ?? 12;
    this.#readFile = options.readFile ?? ((filePath) => fs.readFile(filePath, "utf8"));
  }

  relative(filePath: string): string {
    return toRelativePath(filePath, this.#cwd);
  }

  async snippet(location: AnalyzerLocation, mode: PairMode): Promise<Snippet> {
    const lines = await this.#lines(location.filePath);
    const start = Math.max(1, Math.min(location.startLine, lines.length));
    let end = Math.max(start, Math.min(location.endLine, lines.length));
    if (mode === "overlap" && end === start) end = Math.min(lines.length, start + this.#singleLineExtension);
    const code = clipMiddle(dedent(lines.slice(start - 1, end)).join("\n"), this.#maxCodeChars);
    const doc = leadingComment(lines, start);
    return {
      path: toRelativePath(location.filePath, this.#cwd),
      lines: start === end ? String(start) : `${start}-${end}`,
      kind: location.kind,
      name: location.symbolName,
      ...(doc !== undefined ? { doc: clipMiddle(doc, this.#maxDocChars) } : {}),
      code,
    };
  }

  #lines(filePath: string): Promise<string[]> {
    let pending = this.#files.get(filePath);
    if (pending === undefined) {
      pending = this.#readFile(filePath).then((text) => text.split(/\r?\n/));
      this.#files.set(filePath, pending);
    }
    return pending;
  }
}

function leadingComment(lines: string[], start: number): string | undefined {
  let first = start - 1;
  while (first > 0) {
    const line = lines[first - 1] ?? "";
    if (LINE_COMMENT.test(line)) {
      first -= 1;
      continue;
    }
    if (BLOCK_END.test(line)) {
      let opener = first - 1;
      while (opener >= 0 && !BLOCK_START.test(lines[opener] ?? "")) opener -= 1;
      if (opener < 0) break;
      first = opener;
      continue;
    }
    break;
  }
  if (first === start - 1) return undefined;
  return (
    dedent(lines.slice(first, start - 1))
      .join("\n")
      .trim() || undefined
  );
}

function dedent(lines: string[]): string[] {
  let indent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)));
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 40) / 2);
  return `${text.slice(0, keep)}\n/* ... ${text.length - 2 * keep} characters omitted ... */\n${text.slice(-keep)}`;
}

export function toRelativePath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  const chosen = relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? filePath : relative;
  return chosen.split(path.sep).join("/");
}
