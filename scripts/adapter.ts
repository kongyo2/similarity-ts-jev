import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TypeSafeClient } from "@typesafe-ai/sdk";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.SDK_ADAPTER_DIR,
  path.join(root, "..", "jev-playground", "sdk-adapter"),
  path.join(root, "..", "sdk-adapter"),
].filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "");

type AdapterModule = {
  createJevClient: (config?: { logLevel?: "debug" | "info" | "warn" | "error" | "off"; timeout?: number }) => TypeSafeClient;
};

export function adapterDir(): string {
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "src", "index.ts")));
  if (found === undefined) {
    throw new Error(
      `sdk-adapter not found. Set SDK_ADAPTER_DIR to jev-playground/sdk-adapter (tried ${candidates.join(", ")}).`,
    );
  }
  return found;
}

function loadEnv(dir: string): void {
  const file = path.join(dir, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || line.trimStart().startsWith("#")) continue;
    const [, name, raw] = match;
    if (process.env[name!] !== undefined) continue;
    process.env[name!] = raw!.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export async function createAdapterClient(config: { logLevel?: "debug" | "info" | "warn" | "error" | "off"; timeout?: number } = {}): Promise<TypeSafeClient> {
  const dir = adapterDir();
  loadEnv(dir);
  const adapter = (await import(pathToFileURL(path.join(dir, "src", "index.ts")).href)) as AdapterModule;
  return adapter.createJevClient({ logLevel: "warn", timeout: 60_000, ...config });
}
