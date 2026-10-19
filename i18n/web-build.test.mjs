import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { webI18nPlugin } from "./web-build.mjs";
import { createTranslator } from "./core.js";
import { readDictionary } from "./plugin.mjs";
import { repoRoot } from "./rules.mjs";

beforeEach(() => vi.stubEnv("VITEST", ""));
afterEach(() => vi.unstubAllEnvs());

it.each(["zh-CN", "en"])(
  "preserves typed values while translating labels in %s",
  async (locale) => {
    const id = NodePath.join(repoRoot, "apps/web/src/build-fixture.ts");
    const source =
      'const result: {label: string; value: string} = {label: "Settings", value: "Settings"};';
    const output = await webI18nPlugin("production").transform(source, id);
    const code = NodeModule.stripTypeScriptTypes(output.code).replace(/^import[^;]+;\n/gm, "");
    const { __t } = createTranslator(readDictionary(), () => locale);
    expect(new Function("_t", code + ";return result;")(__t)).toEqual({
      label: locale === "en" ? "Settings" : "设置",
      value: "Settings",
    });
  },
);

it("passes translated TSX to the upstream native React Compiler", async () => {
  const id = NodePath.join(repoRoot, "apps/web/src/build-fixture.tsx");
  const translated = await webI18nPlugin("production").transform(
    'export function SettingsLabel({value}: {value: string}) { return <button aria-label="Settings">{value}</button>; }',
    id,
  );
  const webRequire = NodeModule.createRequire(new URL("../apps/web/package.json", import.meta.url));
  const { transform } = webRequire("oxc-transform-react");
  const compiled = await transform(id, translated.code, { reactCompiler: {}, sourcemap: true });
  expect(compiled.fatal, JSON.stringify(compiled.errors)).toBe(false);
  expect(compiled.code).toContain('_t("Settings")');
  expect(compiled.code).toContain("react/compiler-runtime");
});

it("keeps upstream tests and sources outside the translation scope untouched", async () => {
  const id = NodePath.join(repoRoot, "apps/web/src/build-fixture.ts");
  expect(await webI18nPlugin("test").transform('const label = "Settings";', id)).toBeNull();
  vi.stubEnv("VITEST", "true");
  expect(await webI18nPlugin("production").transform('const label = "Settings";', id)).toBeNull();
});
