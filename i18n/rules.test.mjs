import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodePath from "node:path";
import { babel } from "./babel.mjs";
import plugin from "./plugin.mjs";
import { classify, inScope, jsxText, repoRoot } from "./rules.mjs";
import { createTranslator } from "./core.js";

const filename = NodePath.join(repoRoot, "apps/web/src/i18n-fixture.tsx");
const dictionary = {
  "New thread": "新建对话",
  Settings: "设置",
  Save: "保存",
  Close: "关闭",
  "{0} comment{1}": "{0} 条评论",
  "{0} then {1}": "{1} 然后 {0}",
};
const transform = (code, options = {}) =>
  babel.transformSync(code, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [[plugin, { dictionary, ignore: {}, ...options }]],
  }).code;
const candidates = (code) => {
  const result = [];
  babel.traverse(
    babel.parseSync(code, {
      filename,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
    }),
    {
      "StringLiteral|TemplateLiteral|JSXText"(path) {
        const item = classify(path);
        if (item?.eligible) result.push(item);
      },
    },
  );
  return result;
};
beforeEach(() => vi.stubEnv("VITEST", ""));
afterEach(() => vi.unstubAllEnvs());

describe("protected positions, using the production plugin entry", () => {
  it.each([
    'x === "New thread"',
    'x !== "New thread"',
    'x == "New thread"',
    'x != "New thread"',
    '"New thread" in x',
    'switch(x) { case "New thread": break; }',
    'Schema.Literal("New thread")',
    'Schema.Literals(["New thread"])',
    'Schema.TaggedError()("New thread", { title: "Settings" })',
    'Literal("New thread")',
    'import * as S from "effect/Schema"; S.Literals(["New thread"])',
    'import { Schema as S } from "effect"; S.Literals(["New thread"])',
    'import.meta.glob("New thread")',
    'new URL("New thread", import.meta.url)',
    'import "New thread"',
    'export {x} from "New thread"',
    'import("New thread")',
    'type T = "New thread"',
    'enum T { A = "New thread" }',
    'const x = {"New thread": 1}',
    'x["New thread"]',
    '<p className="New thread" />',
    '<p id={yes ? "New thread" : "Settings"} />',
    '<p data-test="New thread" />',
    '<p type="New thread" href="New thread" role="New thread" />',
    '<p variant="New thread" size="New thread" src="New thread" key="New thread" />',
    'x.includes("New thread")',
    'x?.startsWith("New thread")',
    'x.endsWith("New thread")',
    'x.indexOf("New thread")',
    'x.match("New thread")',
    'x.replace("New thread", "New thread")',
    'console.log("New thread")',
    'logger.info({ message: "New thread" })',
    'Effect.logInfo("New thread")',
    'logger.info(() => "New thread")',
    'x.replace("a", () => "New thread")',
    "css`New thread`",
    'sql`New thread ${"Settings"}`',
    'wc.executeJavaScript("New thread")',
    'page.evaluate("New thread")',
    'const x = { name: "New thread", value: "New thread", className: "New thread" }',
  ])("never translates %s", (code) => {
    expect(transform(code)).not.toContain("__t as");
    expect(transform(code)).not.toContain("__tf as");
    expect(candidates(code)).toEqual([]);
  });

  it("leaves dictionary misses and intentional English untouched", () => {
    expect(transform('<p title="Unknown phrase">Codex</p>')).not.toContain("import {");
    expect(
      transform("<p>Settings</p>", { ignore: { Settings: { category: "fixture" } } }),
    ).not.toContain("import {");
  });
  it("disables the production plugin in both test modes", () => {
    expect(transform("<p>Settings</p>", { mode: "test" })).not.toContain("import {");
    vi.stubEnv("VITEST", "true");
    expect(transform("<p>Settings</p>")).not.toContain("import {");
  });
});

describe("UI candidates and rewriting", () => {
  it.each([
    "<p>New thread</p>",
    "<Row control={<button>Save</button>} />",
    '<Row control={<button aria-label="Settings">Save</button>} />',
    '<p title="Settings" />',
    '<p aria-label={"Settings"} />',
    "<p placeholder={`New thread`} />",
    '<p label={x ? "Save" : "Close"} />',
    '<p>{"Settings"}</p>',
    '<p>{x ? "Save" : "Close"}</p>',
    '<p>{x ?? "Settings"}</p>',
    '<p>{x || "Settings"}</p>',
    'const x = {title: "Settings"}',
    'const x = {message: cond ? "Save" : "Close"}',
    'const x = "New thread"',
    'const x = { title: "Settings" as const }',
    'const x = {buttons: ["Save", "Close"]}',
  ])("extracts exactly the literals it rewrites: %s", (code) => {
    const items = candidates(code);
    expect(items.length).toBeGreaterThan(0);
    const output = transform(code);
    expect(output).toContain("import {");
    let calls = 0;
    babel.traverse(
      babel.parseSync(output, {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
      }),
      {
        CallExpression(path) {
          if (/t[f]?\d*$/.test(path.node.callee.name ?? "")) calls++;
        },
      },
    );
    expect(calls).toBe(items.length);
  });
  it("keeps single words outside UI out of the denominator", () => {
    expect(candidates('const x = "Settings"')).toEqual([]);
    expect(transform('const x = "Settings"')).not.toContain("import {");
  });
  it("matches JSX whitespace semantics and preserves significant edges", () => {
    expect(jsxText("\n  New\n  thread\n")).toBe("New thread");
    expect(jsxText(" Save ")).toBe(" Save ");
    expect(jsxText("New  thread")).toBe("New  thread");
    expect(candidates("<p>\n  New\n  thread\n</p>")[0].key).toBe("New thread");
    expect(transform("<p> Save </p>")).toContain('(" Save ")');
  });
  it("handles templates with English plural fragments and reordered placeholders", () => {
    const output = transform('const result = {text: `${n} comment${n === 1 ? "" : "s"}`}.text;');
    const body = output.replace(/^import[^;]+;\n/, "");
    const { __tf } = createTranslator(dictionary, () => "zh-CN");
    expect(new Function("_tf", "n", `${body}; return result;`)(__tf, 2)).toBe("2 条评论");
    expect(candidates('({text: `${n} comment${n === 1 ? "" : "s"}`})')[0].placeholders).toEqual([
      { token: "{0}", expression: "n" },
      { token: "{1}", expression: 'n === 1 ? "" : "s"' },
    ]);
  });
  it("evaluates and coerces each interpolation once in source order", () => {
    const code = transform("const result = {text: `${first()} then ${second()}`}.text").replace(
      /^import[^;]+;\n/,
      "",
    );
    const order = [];
    const first = () => {
      order.push("first");
      return {
        toString() {
          order.push("coerce");
          return "A";
        },
      };
    };
    const second = () => {
      order.push("second");
      return "B";
    };
    const { __tf } = createTranslator(dictionary, () => "zh-CN");
    expect(
      new Function("_tf", "first", "second", `${code}; return result;`)(__tf, first, second),
    ).toBe("B 然后 A");
    expect(order).toEqual(["first", "coerce", "second"]);
  });
  it("does not turn literal placeholders into ambiguous templates", () => {
    expect(candidates("`New thread {0} ${x}`")).toEqual([]);
  });
  it("avoids import name collisions and handles workspace source files", () => {
    expect(transform('const _t = 1; const x = {title: "Settings"}')).toContain("__t as _t2");
    expect(inScope(NodePath.join(repoRoot, "packages/shared/src/example.ts"))).toBe(true);
    expect(inScope(NodePath.join(repoRoot, "apps/mobile/src/example.tsx"))).toBe(false);
    expect(inScope(NodePath.join(repoRoot, "apps/server/src/example.ts"))).toBe(false);
    expect(inScope(NodePath.join(repoRoot, "apps/web/src/example.test.tsx"))).toBe(false);
  });
  it("keeps audited thread data in English while translating its visible action", () => {
    const file = NodePath.join(repoRoot, "packages/client-runtime/src/operations/threadTitle.ts");
    const source = 'export const seed = () => "New thread"';
    const output = babel.transformSync(source, {
      filename: file,
      configFile: false,
      babelrc: false,
      plugins: [[plugin, { dictionary, ignore: {} }]],
    }).code;
    expect(output).not.toContain("__t as");
    const ast = babel.parseSync(source, { configFile: false, babelrc: false });
    babel.traverse(ast, {
      StringLiteral(path) {
        const item = classify(path, { filename: file });
        expect(item.eligible).toBe(false);
        expect(item.reason).toMatch(/^reviewed:/);
      },
    });
    expect(transform("<button>New thread</button>")).toContain("__t as");
  });
});
