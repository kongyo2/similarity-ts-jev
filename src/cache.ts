import fs from "node:fs/promises";
import path from "node:path";
import type { JudgeCache, JudgeRejection, JudgeRequest, JudgeResponse } from "./judge.ts";

export interface CacheEntry {
  request: JudgeRequest;
  response: JudgeResponse | JudgeRejection;
}

export interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export class FileJudgeCache implements JudgeCache {
  readonly #entries: Map<string, CacheEntry>;
  #dirty = false;

  constructor(entries: Map<string, CacheEntry> = new Map()) {
    this.#entries = entries;
  }

  static async load(filePath: string): Promise<FileJudgeCache> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new FileJudgeCache();
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<CacheFile>;
    if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      throw new Error(`${filePath} is not a similarity-ts-jev cache file`);
    }
    return new FileJudgeCache(new Map(Object.entries(parsed.entries)));
  }

  get size(): number {
    return this.#entries.size;
  }

  get(hash: string): JudgeResponse | JudgeRejection | undefined {
    return this.#entries.get(hash)?.response;
  }

  set(hash: string, request: JudgeRequest, response: JudgeResponse | JudgeRejection): void {
    this.#entries.set(hash, { request, response });
    this.#dirty = true;
  }

  entries(): IterableIterator<[string, CacheEntry]> {
    return this.#entries.entries();
  }

  async save(filePath: string): Promise<boolean> {
    if (!this.#dirty) return false;
    const file: CacheFile = { version: 1, entries: Object.fromEntries(this.#entries) };
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(file)}\n`, "utf8");
    this.#dirty = false;
    return true;
  }
}
