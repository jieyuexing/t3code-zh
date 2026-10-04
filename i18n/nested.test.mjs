import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import { babel } from "./babel.mjs";
import plugin from "./plugin.mjs";
import { classifyAll, repoRoot } from "./rules.mjs";
import { createTranslator } from "./core.js";

const filename = NodePath.join(repoRoot, "apps/web/src/nested-fixture.tsx");
function extract(source, file = filename) {
  const items = [];
  babel.traverse(
    babel.parseSync(source, {
      filename: file,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
    }),
    {
      "JSXText|StringLiteral|TemplateLiteral"(path) {
        items.push(...classifyAll(path, { filename: file }).filter((item) => item.eligible));
      },
    },
  );
  return items;
}
function compile(source, dictionary, ignore = {}) {
  return babel.transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [[plugin, { dictionary, ignore }]],
  }).code;
}
function evaluate(source, dictionary, locale = "zh-CN", values = {}, ignore = {}) {
  const code = compile(source, dictionary, ignore).replace(/^import[^;]+;\n/, "");
  const { __t, __tf, __th } = createTranslator(dictionary, () => locale);
  return new Function("_t", "_tf", "_th", ...Object.keys(values), `${code}; return result;`)(
    __t,
    __tf,
    __th,
    ...Object.values(values),
  );
}
beforeEach(() => vi.stubEnv("VITEST", ""));
afterEach(() => vi.unstubAllEnvs());

describe("nested template traversal", () => {
  it.each([
    "of {0}",
    ", expired",
    "or ⌘↵",
    "on",
    "off",
    "Hide",
    "Show",
    "Remove",
    "Add",
    "from",
    "to",
  ])("rewrites UI fragment %s with a translated or missing parent", (key) => {
    const literal = key.includes("{0}") ? "` of ${total}`" : JSON.stringify(key);
    const source = "const result = {title: `Status: ${enabled ? " + literal + ' : ""}`}.title;';
    const inner = key === "of {0}" ? "of {0}" : key;
    expect(extract(source).map((item) => item.key)).toContain(inner);
    expect(evaluate(source, { [inner]: "片段{0}" }, "zh-CN", { enabled: true, total: 4 })).toBe(
      key === "of {0}" ? "Status:  片段4" : "Status: 片段{0}",
    );
    expect(
      evaluate(source, { [inner]: "片段", "Status: {0}": "状态{0}" }, "zh-CN", {
        enabled: true,
        total: 4,
      }),
    ).toContain("状态");
    expect(compile(source, { [inner]: "片段" }, { [inner]: {} })).not.toContain("import {");
  });
  it.each([
    'x === `Status: ${enabled ? "Hide" : "Show"}`',
    'Schema.Literal(`Status: ${enabled ? "Hide" : "Show"}`)',
    'console.log(`Status: ${enabled ? "Hide" : "Show"}`)',
    '<p className={`Status: ${enabled ? "Hide" : "Show"}`} />',
    'css`Status: ${enabled ? "Hide" : "Show"}`',
    'x.includes(`Status: ${enabled ? "Hide" : "Show"}`)',
    'evaluateWithDebugger(tab, send, `Status: ${enabled ? "Hide" : "Show"}`)',
  ])("preserves protections through %s", (source) => {
    expect(extract(source)).toEqual([]);
    expect(compile(source, { "Status: {0}": "状态", Hide: "隐藏", Show: "显示" })).not.toContain(
      "import {",
    );
  });
  it("coerces nested expressions exactly once in order even when translations omit or reorder them", () => {
    const events = [];
    const value = (name) => {
      events.push(name);
      return {
        toString() {
          events.push(`coerce ${name}`);
          return name;
        },
      };
    };
    const source =
      'const result = {title: `First ${value("a")} then ${`Nested ${value("b")} ${value("c")}`} last ${value("d")}`}.title;';
    const dictionary = {
      "First {0} then {1} last {2}": "{2}/{1}/{0}",
      "Nested {0} {1}": "内部{1}",
    };
    expect(evaluate(source, dictionary, "zh-CN", { value })).toBe("d/内部c/a");
    expect(events).toEqual(["a", "coerce a", "b", "coerce b", "c", "coerce c", "d", "coerce d"]);
  });
  it("supports the exact local plural helper, including empty suffix translations", () => {
    const source =
      'const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`; const result = plural(n, "element");';
    expect(extract(source).map((item) => item.key)).toEqual(["s", "element"]);
    expect(evaluate(source, { s: "", element: "元素" }, "zh-CN", { n: 2 })).toBe("2 元素");
    expect(evaluate(source, { s: "", element: "元素" }, "en", { n: 2 })).toBe("2 elements");
    expect(extract('api.plural(2, "element")')).toEqual([]);
    expect(
      extract(source.replace('plural(n, "element")', 'api.plural(n, "element")')).map(
        (item) => item.key,
      ),
    ).toEqual(["s"]);
    expect(extract('const plural = (count, noun) => noun; plural(2, "element")')).toEqual([]);
  });
  it("recognizes relative-time presentation fields without opening generic value fields", () => {
    const source =
      'function formatRelativeTime() { return {value: "just now", suffix: null}; } const result = formatRelativeTime().value;';
    expect(evaluate(source, { "just now": "刚刚" })).toBe("刚刚");
    expect(extract('function state() { return {value: "just now", suffix: null}; }')).toEqual([]);
    expect(extract('function formatRelativeTime() { return {value: "New thread"}; }')).toEqual([]);
  });
});

describe("inline HTML text spans", () => {
  const html =
    '<!doctype html><html><style>.x{content:"New thread"}</style><body><p title="Window title">Connecting to WSL…</p><script>node.textContent=value.windowTitle||"Captured window"; const protocol="New thread";</script></body></html>';
  it("extracts visible text and accessibility attributes, excluding markup, CSS and other script literals", () => {
    expect(extract(`const result = ${JSON.stringify(html)}`).map((item) => item.key)).toEqual([
      "Window title",
      "Connecting to WSL…",
      "Captured window",
    ]);
    expect(extract(`console.log(${JSON.stringify(html)})`)).toEqual([]);
    expect(extract(`const data = {value: ${JSON.stringify(html)}}`)).toEqual([]);
  });
  it("preserves document structure and quotes/escapes translations for their destinations", () => {
    const dictionary = {
      "Window title": '标题"<',
      "Connecting to WSL…": "连接 & 等待",
      "Captured window": '窗口"</script>',
    };
    const source = `const result = ${JSON.stringify(html)}`;
    expect(evaluate(source, dictionary)).toBe(
      html
        .replace("<html>", '<html lang="zh-CN">')
        .replace('title="Window title"', 'title="标题&quot;&lt;"')
        .replace("Connecting to WSL…", "连接 &amp; 等待")
        .replace('"Captured window"', '"窗口\\"\\u003c/script>"'),
    );
    expect(evaluate(source, dictionary, "en")).toBe(html);
    expect(evaluate(source, dictionary, "zh-CN", {}, { "Captured window": {} })).toContain(
      '||"Captured window"',
    );
  });
  it("preserves document interpolation order, CSS values and dictionary misses", () => {
    const source =
      'const result = `<!doctype html><style>p{color:${value("red")}}</style><p>Set up ${value("app")}</p><p>Unknown label</p>`';
    const events = [];
    const value = (name) => {
      events.push(name);
      return {
        toString() {
          events.push(`coerce ${name}`);
          return name;
        },
      };
    };
    expect(evaluate(source, { "Set up {0}": "设置 {0}" }, "zh-CN", { value })).toBe(
      "<!doctype html><style>p{color:red}</style><p>设置 app</p><p>Unknown label</p>",
    );
    expect(events).toEqual(["red", "coerce red", "app", "coerce app"]);
  });
  it("does not treat commented or quoted textContent assignments as visible text", () => {
    const html =
      '<!doctype html><script>/* node.textContent=value.name||"Comment only"; */ const code = \'node.textContent=value.name||"Quoted code"\';</script>';
    expect(extract(`const result = ${JSON.stringify(html)}`)).toEqual([]);
    expect(extract("const result = `<!doctype html><p>Literal {0} ${value}</p>`")).toEqual([]);
  });
});

describe("reported production locations", () => {
  it("compacts translated relative times by structure, without English comparisons", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(repoRoot, "apps/web/src/components/Sidebar.tsx"),
      "utf8",
    );
    const helper = source.match(/function compactSidebarTimeLabel\([\s\S]+?\n}/)[0];
    const code =
      NodeModule.stripTypeScriptTypes(helper) + ";const result = compactSidebarTimeLabel(time);";
    expect(
      evaluate(code, { now: "现在" }, "zh-CN", { time: { value: "刚刚", suffix: null } }),
    ).toBe("现在");
    expect(evaluate(code, {}, "en", { time: { value: "just now", suffix: null } })).toBe("now");
    expect(evaluate(code, {}, "zh-CN", { time: { value: "2 分钟", suffix: "前" } })).toBe("2 分钟");
    expect(evaluate(code, {}, "zh-CN", { time: null })).toBe("");
  });
  it.each([
    ["apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx", "Show"],
    ["apps/web/src/components/pullRequest/PullRequestStackMenu.tsx", "of"],
    ["apps/web/src/components/composerContextPresentation.tsx", "s"],
    ["apps/web/src/lib/composerContextRecords.ts", "drawing"],
    ["apps/desktop/src/snapShot/SnapShotTransition.ts", "Captured window"],
    ["apps/desktop/src/window/DesktopWindow.ts", "Connecting to WSL…"],
    ["apps/desktop/src/permissions/MacPermissionHelper.ts", "Close permission helper"],
    ["apps/web/src/components/device/DeviceControlsRail.tsx", "Switch device to dark mode"],
    ["apps/web/src/components/media/MediaActions.tsx", "video"],
    ["apps/web/src/components/settings/ConnectionsSettings.tsx", "Could not switch backend on"],
  ])("extracts and rewrites %s: %s", (file, key) => {
    const filename = NodePath.join(repoRoot, file);
    const source = NodeFS.readFileSync(filename, "utf8");
    expect(extract(source, filename).some((item) => item.key === key)).toBe(true);
    const code = compile(source, { [key]: "验证" });
    expect(code).toMatch(/__t(?:f|h)? as/);
  });
});
