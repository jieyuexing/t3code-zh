import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodePath from "node:path";
import { babel } from "./babel.mjs";
import plugin from "./plugin.mjs";
import { classify, inScope, jsxText, repoRoot, uiProperties } from "./rules.mjs";
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

describe("reviewed UI shapes", () => {
  it.each([...uiProperties])("recognizes %s without bypassing comparisons or style", (prop) => {
    expect(candidates(`<Row ${prop}={"Settings"} />`).map((x) => x.key)).toEqual(["Settings"]);
    expect(transform(`<Row ${prop}={"Settings"} />`)).toContain('("Settings")');
    expect(candidates(`<Row ${prop}={x === "Settings"} />`)).toEqual([]);
    expect(candidates(`const x = {className: {${JSON.stringify(prop)}: "New thread"}}`)).toEqual(
      [],
    );
  });

  it.each([
    [
      '<Row inputProps={{placeholder: "Settings", id: "New thread"}} />',
      'const x = {inputProps: {id: "New thread"}}',
    ],
    [
      '<Row permissions={[{title: "Settings", id: "New thread"}]} />',
      '<Row permissions={["Settings"]} />',
    ],
    ['<Row presentation={{label: "Settings"}} />', '<Row presentation="New thread" />'],
    ['<Row size={{label: "Settings", value: "New thread"}} />', '<Row size="New thread" />'],
    ['<Row labels={["Settings"]} />', '<Row labels={{id: "New thread"}} />'],
    ['<Row headers={["Settings"]} />', 'fetch(url, {headers: {Authorization: "New thread"}})'],
    [
      '<DiagnosticsTable headers={["Settings"]} />',
      '<Browser headers={{Authorization: "New thread"}} />',
    ],
    ['<Row steps={["Settings"]} />', 'const x = {steps: ["Settings"]}'],
    ['const x = {labels: ["Settings"]}', 'const x = {values: ["Settings"]}'],
    ['const STATE_LABELS = {ready: "Settings"}', 'const STATE_IDS = {ready: "Settings"}'],
    ['const PICKER_TOOLTIP = "Settings"', 'const PICKER_TOOLTIP_SIDE = "Settings" as const'],
    ['const STATUS_LABEL_BY_KIND = {ready: "Settings"}', 'const STATUS_LABEL_CLASS = "Settings"'],
    ['const LABEL_BY_KIND = {path: "Settings"}', 'const IDS_BY_KIND = {path: "New thread"}'],
    ['const SAVED_LABELS = {variant: "Settings"}', 'const x = {variant: "New thread"}'],
    ['const actionLabel = yes ? "Settings" : "Close"', 'const actionId = "Settings"'],
    ['function stateLabel() {return "Settings"}', 'function stateId() {return "Settings"}'],
    ['const stateLabel = () => "Settings"', 'const stateId = () => "Settings"'],
    [
      'const filters = [{name: "Settings", extensions: ["json"]}]',
      'const x = {name: "New thread"}',
    ],
    [
      'const filters = [{name: "Settings", extensions: formats}]',
      'const x = {extensions: ["Settings"]}',
    ],
    [
      'const profiles = [{id: DEFAULT_BROWSER_PROFILE_ID, name: "Settings"}]',
      'const profiles = [{id: profileId, name: "New thread"}]',
    ],
    [
      'const source = {name: window?.title || "Settings"}',
      'const source = {name: file?.name || "New thread"}',
    ],
    [
      '<Row onExpand={() => expandMedia({images: [{src: url, name: "Settings"}]})} />',
      'const x = {name: "New thread", type: "string"}',
    ],
    ['<PullRequestCopyableCode target="Settings" />', '<a target="New thread" />'],
    ['<NetworkAccessDescription fallback="Settings" />', '<Row fallback="New thread" />'],
    ['<SettingsRow status="Settings" />', '<Row status="New thread" />'],
    ['<PullRequestsUnavailableState error="Settings" />', '<Row error="New thread" />'],
    [
      '<Row onClick={() => toastManager.add({title: "Settings"})} />',
      '<Row onClick={() => socket.send("New thread")} />',
    ],
    [
      '<Row onClick={() => toast.error("Settings")} />',
      '<Row onClick={() => logger.error("New thread")} />',
    ],
    [
      '<Row onClick={() => confirm("Settings")} />',
      '<Row onClick={() => confirm(x === "New thread")} />',
    ],
    ['<Row onError={() => setError("Settings")} />', '<Row onClick={() => setId("New thread")} />'],
    [
      '<Row onClick={() => setLanguageError("Settings")} />',
      '<Row onClick={() => setError(Schema.Literal("New thread"))} />',
    ],
    [
      '<Row onClick={() => new Notification("Settings")} />',
      '<Row onClick={() => new URL("New thread")} />',
    ],
    [
      '<Row onClick={() => copyReference(url, "Settings")} />',
      '<Row onClick={() => copyReference("New thread", id)} />',
    ],
    [
      '<Row onClick={() => writeTextToClipboard(url, "Settings")} />',
      '<Row onClick={() => writeTextToClipboard("New thread", id)} />',
    ],
    ['<Row value={booleanStateLabel(state, {true: "Settings"})} />', '<Row value="New thread" />'],
    [
      'const x = {code: resolveFamilyLabel(font) ?? "Settings"}',
      'const x = {code: resolveFamilyId(font) ?? "New thread"}',
    ],
    [
      'const createProfile = (baseName) => {}; <Row onClick={() => createProfile("Settings")} />',
      'const createProfile = (id) => {}; <Row onClick={() => createProfile("New thread")} />',
    ],
    [
      'function runCommand(label, action) {};<Row onClick={() => runCommand("Settings", action)} />',
      'function runCommand(command, action) {};<Row onClick={() => runCommand("New thread", action)} />',
    ],
  ])(
    "extracts the reviewed positive shape and protects its counterexample: %s",
    (positive, negative) => {
      expect(candidates(positive).some((x) => x.key === "Settings")).toBe(true);
      expect(transform(positive)).toContain('("Settings")');
      expect(candidates(negative)).toEqual([]);
      expect(transform(negative)).not.toContain("import {");
    },
  );
});

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
  it("translates children of an interpolation-only template, which cannot itself be rewritten", () => {
    const code = '<p>{`${enabled ? "Save" : "Close"}`}</p>';
    expect(candidates(code).map((item) => item.key)).toEqual(["Save", "Close"]);
    const output = transform(code);
    expect(output).toContain('_t("Save")');
    expect(output).toContain('_t("Close")');
    expect(candidates('<p className={`${enabled ? "Save" : "Close"}`} />')).toEqual([]);
    expect(candidates('Schema.Literal(`${enabled ? "Save" : "Close"}`)')).toEqual([]);
    expect(candidates('css`${enabled ? "New thread" : "Close"}`')).toEqual([]);
  });
  it("keeps children of a translatable template out of extraction until the transformer can visit them", () => {
    const code = '<p>{`New thread ${enabled ? "Save" : "Close"}`}</p>';
    expect(candidates(code).map((item) => item.key)).toEqual(["New thread {0}"]);
    const output = transform(code, {
      dictionary: { "New thread {0}": "测试 {0}", Save: "保存", Close: "关闭" },
    });
    expect(output).toContain('_tf("New thread {0}"');
    expect(output).not.toContain('_t("Save")');
  });
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
