import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SnippetReader } from "../src/snippets.ts";

function reader(text: string) {
  return new SnippetReader({ cwd: "/r", readFile: async () => text });
}

describe("SnippetReader", () => {
  it("keeps the comment block above the declaration, whatever its shape", async () => {
    const cases: [string, string | undefined][] = [
      ["/**\n * Doc.\n */\nexport function f() {}\n", "/**\n * Doc.\n */"],
      ["/*\nplain text\nmore\n*/\nexport function f() {}\n", "/*\nplain text\nmore\n*/"],
      ["/* one line */\nexport function f() {}\n", "/* one line */"],
      ["// a\n// b\nexport function f() {}\n", "// a\n// b"],
      ["const x = 1;\n// a\n/* b\nc */\nexport function f() {}\n", "// a\n/* b\nc */"],
      ["const x = 1;\n\nexport function f() {}\n", undefined],
      ["text without an opener\n*/\nexport function f() {}\n", undefined],
    ];
    for (const [text, doc] of cases) {
      const start = text.split("\n").findIndex((line) => line.startsWith("export function")) + 1;
      const snippet = await reader(text).snippet(
        { filePath: "/r/a.ts", startLine: start, endLine: start, symbolName: "f", kind: "function" },
        "functions",
      );
      assert.equal(snippet.doc, doc, JSON.stringify(text));
      assert.equal(snippet.code, "export function f() {}");
    }
  });

  it("dedents the code, clips very long declarations, and extends single-line overlap windows", async () => {
    const lines = [
      "function outer() {",
      "    const a = 1;",
      "    const b = 2;",
      "  }",
      ...Array.from({ length: 20 }, (_, i) => `line ${i}`),
    ];
    const text = lines.join("\n");
    const inner = await reader(text).snippet(
      { filePath: "/r/a.ts", startLine: 2, endLine: 3, symbolName: "a", kind: "fragment" },
      "overlap",
    );
    assert.equal(inner.code, "const a = 1;\nconst b = 2;");
    assert.equal(inner.lines, "2-3");
    const window = await reader(text).snippet(
      { filePath: "/r/a.ts", startLine: 5, endLine: 5, symbolName: "w", kind: "fragment" },
      "overlap",
    );
    assert.equal(window.lines, "5-17");
    const clipped = await new SnippetReader({
      cwd: "/r",
      maxCodeChars: 100,
      readFile: async () => "x".repeat(400),
    }).snippet({ filePath: "/r/a.ts", startLine: 1, endLine: 1, symbolName: "x", kind: "function" }, "functions");
    assert.ok(clipped.code.length < 200 && clipped.code.includes("characters omitted"));
  });
});
