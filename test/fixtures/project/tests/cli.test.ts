import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function withTempProject(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), content, "utf8");
    }
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function cliTest(): Promise<void> {
  await withTempProject({ "a.ts": "export const a = 1;" }, async (dir) => {
    console.log("cli", dir);
  });
}
