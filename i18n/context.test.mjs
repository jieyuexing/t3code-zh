import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { babel } from "./babel.mjs";
import plugin from "./plugin.mjs";
import { createTranslator } from "./core.js";
import { readContextDictionary } from "./context.mjs";
import { coverage, extract } from "./coverage.ts";
import { repoRoot } from "./rules.mjs";

const relative = "apps/web/src/context-fixture.tsx";
const filename = NodePath.join(repoRoot, relative);
function transform(code, contexts, dictionary = {}, ignore = {}, file = filename) {
  return babel.transformSync(code, {
    filename: file,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [[plugin, { dictionary, ignore, contexts }]],
  }).code;
}
function evaluate(source, contexts, dictionary, locale) {
  const code = transform(source, contexts, dictionary).replace(/^import[^;]+;\n/, "");
  const { __t, __tf, __th } = createTranslator(dictionary, () => locale);
  return new Function("_t", "_tf", "_th", code + ";return result;")(__t, __tf, __th);
}
beforeEach(() => vi.stubEnv("VITEST", ""));
afterEach(() => vi.unstubAllEnvs());

describe("file and line translations", () => {
  it("uses a file override through the same runtime while retaining English and whitespace", () => {
    const contexts = { [relative]: { Share: "占比" } };
    const source = 'const result = {label: " Share "}.label';
    expect(evaluate(source, contexts, { Share: "分享" }, "zh-CN")).toBe(" 占比 ");
    expect(evaluate(source, contexts, { Share: "分享" }, "en")).toBe(" Share ");
    expect(evaluate(source, {}, { Share: "分享" }, "zh-CN")).toBe(" 分享 ");
    expect(evaluate(source, { [relative]: { Share: "" } }, {}, "zh-CN")).toBe("  ");
  });
  it("supports templates and HTML spans without changing placeholder order or markup", () => {
    const contexts = { [relative]: { "Share {0}": "占比{0}", Share: "占比" } };
    expect(evaluate("const result = {label: `Share ${3}`}.label", contexts, {}, "zh-CN")).toBe(
      "占比3",
    );
    expect(evaluate("const result = `<!doctype html><p>Share</p>`", contexts, {}, "zh-CN")).toBe(
      "<!doctype html><p>占比</p>",
    );
  });
  it("only uses explicit context entries, including an intentional override of an ignored display word", () => {
    expect(transform("<p>constructor</p>", { [relative]: {} })).not.toContain("import {");
    expect(
      transform("<p>Share</p>", { [relative]: { Share: "占比" } }, {}, { Share: {} }),
    ).toContain('_t("Share",');
  });
  it.each([
    'x === "Share"',
    'Schema.Literal("Share")',
    '<Row value="Share" />',
    'const x = {id:"Share"}',
  ])("does not let an override bypass protections: %s", (source) => {
    expect(transform(source, { [relative]: { Share: "占比" } })).not.toContain("import {");
  });
  it("prefers a line entry, leaves other same-file occurrences global, and never bleeds to another file", () => {
    const source =
      'const a = {label:"Clear"};\nconst b = {label:"Clear"};\nconst result = a.label + b.label;';
    const contexts = { [relative]: { "Clear::line=1": "清透" } };
    expect(evaluate(source, contexts, { Clear: "清除" }, "zh-CN")).toBe("清透清除");
    expect(
      transform(
        source,
        contexts,
        { Clear: "清除" },
        {},
        filename.replace("context-fixture", "other"),
      ),
    ).not.toContain("清透");
  });
  it("counts every occurrence, so a partial context translation cannot hide global misses", () => {
    const file = NodePath.join(repoRoot, "apps/web/src/components/device/DeviceToolsPanel.tsx");
    const relative = "apps/web/src/components/device/DeviceToolsPanel.tsx";
    const partial = extract([file], {
      [relative]: { "Clear::line=211": "清透" },
    }).candidates.filter((x) => x.key === "Clear");
    expect(partial[0].contextTranslatedOccurrences).toBe(1);
    expect(partial[0].occurrenceCount).toBe(2);
    expect(coverage(partial, {}, {}).missing).toBe(1);
    const complete = extract([file], { [relative]: { Clear: "清除" } }).candidates.filter(
      (x) => x.key === "Clear",
    );
    expect(coverage(complete, {}, {}).translated).toBe(1);
  });
  it("keeps line-scoped overrides attached to the intended production UI", () => {
    const contexts = readContextDictionary();
    for (const [file, entries] of Object.entries(contexts)) {
      for (const [qualifiedKey, value] of Object.entries(entries)) {
        const result = extract([NodePath.join(repoRoot, file)], {
          [file]: { [qualifiedKey]: value },
        });
        expect(
          result.candidates.some((item) => item.contextTranslatedOccurrences > 0),
          `${file}: ${qualifiedKey}`,
        ).toBe(true);
      }
    }
    const file = NodePath.join(repoRoot, "apps/web/src/components/device/DeviceToolsPanel.tsx");
    const code = transform(
      NodeFS.readFileSync(file, "utf8"),
      contexts,
      { Clear: "清除" },
      {},
      file,
    );
    const clearCalls = [];
    babel.traverse(
      babel.parseSync(code, {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
      }),
      {
        CallExpression(path) {
          if (path.node.callee.name === "_t" && path.node.arguments[0]?.value === "Clear") {
            clearCalls.push(path.node.arguments.map((argument) => argument.value));
          }
        },
      },
    );
    expect(clearCalls).toEqual([["Clear", "清透"], ["Clear"]]);
  });
  it("requires a translation for display-only lookups even if the stored semantic label is ignored", () => {
    const file = NodePath.join(repoRoot, "apps/web/src/components/GitActionsControl.tsx");
    const candidates = extract([file]).candidates.filter((item) => item.key === "Commit");
    expect(coverage(candidates, {}, { Commit: {} }).missing).toBe(1);
    expect(coverage(candidates, { Commit: "提交" }, { Commit: {} }).missing).toBe(0);
    // The source label comparison and producer whitelist still retain English.
    expect(
      transform(
        'const x = {label:"Commit"}; x.label === "Commit"',
        {},
        { Commit: "提交" },
        { Commit: {} },
      ),
    ).not.toContain("import {");
  });
});
