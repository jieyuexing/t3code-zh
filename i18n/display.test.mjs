import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { babel } from "./babel.mjs";
import plugin, { readDictionary } from "./plugin.mjs";
import { createTranslator } from "./core.js";
import { repoRoot } from "./rules.mjs";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("MODE", "production");
  vi.stubGlobal("localStorage", { getItem: () => "zh-CN" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("display-only translation", () => {
  it("translates known provider labels and leaves unknown custom text untouched", async () => {
    const { displayLabel } = await import("./display.js");
    expect(displayLabel("High")).toBe("高");
    expect(displayLabel("Extra High")).toBe("超高");
    expect(displayLabel("Custom provider trait v27")).toBe("Custom provider trait v27");
  });
  it("translates only the exact default title seed, never arbitrary user titles", async () => {
    const { displayThreadTitle } = await import("./display.js");
    expect(displayThreadTitle("New thread")).toBe("新建线程");
    for (const title of ["New thread notes", " New thread", "New Thread", "High", "", "我的线程"])
      expect(displayThreadTitle(title)).toBe(title);
  });
  it("keeps the original seed during rename even when its presentation is Chinese", async () => {
    const { displayThreadTitle } = await import("./display.js");
    const { resolveRenameCommit } = await import("../apps/web/src/components/chat/ChatHeader.tsx");
    const originalTitle = "New thread";
    expect(displayThreadTitle(originalTitle)).toBe("新建线程");
    expect(resolveRenameCommit({ title: originalTitle, originalTitle })).toEqual({
      action: "noop",
    });
    expect(resolveRenameCommit({ title: "My task", originalTitle })).toEqual({
      action: "commit",
      title: "My task",
    });
  });
  it.each(["zh-CN", "en"])(
    "runs the real relative-time formatters through the production transform in %s",
    async (locale) => {
      vi.stubEnv("VITEST", "");
      vi.stubGlobal("localStorage", { getItem: () => locale });
      const { joinRelativeTime } = await import("./display.js");
      const filename = NodePath.join(repoRoot, "apps/web/src/timestampFormat.ts");
      const source = NodeFS.readFileSync(filename, "utf8");
      const names = new Set([
        "parseTimestampDate",
        "formatRelativeTime",
        "formatRelativeTimeLabel",
        "formatRelativeTimeUntil",
        "formatRelativeTimeUntilLabel",
      ]);
      const ast = babel.parseSync(source, {
        filename,
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] },
      });
      ast.program.body = ast.program.body.filter(
        (node) => node.type === "ExportNamedDeclaration" && names.has(node.declaration?.id?.name),
      );
      const dictionary = readDictionary();
      const code = NodeModule.stripTypeScriptTypes(
        babel.transformFromAstSync(ast, source, {
          filename,
          configFile: false,
          babelrc: false,
          plugins: [[plugin, { dictionary }]],
        }).code,
      )
        .replace(/^import[^;]+;\n/gm, "")
        .replaceAll("export ", "");
      const { __t, __tf } = createTranslator(dictionary, () => locale);
      const { past, future } = new Function(
        "_t",
        "_tf",
        "joinRelativeTime",
        code + ";return {past:formatRelativeTimeLabel, future:formatRelativeTimeUntilLabel};",
      )(__t, __tf, joinRelativeTime);
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      try {
        expect(past(new Date(Date.now() - 180_000).toISOString())).toBe(
          locale === "en" ? "3m ago" : "3 分钟前",
        );
        expect(past(new Date(Date.now()).toISOString())).toBe(
          locale === "en" ? "just now" : "刚刚",
        );
        expect(past("invalid")).toBe("");
        expect(future(new Date(Date.now() + 180_000).toISOString())).toBe(
          locale === "en" ? "3m left" : `3 分钟${dictionary.left}`,
        );
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
  it("joins both split JSX suffixes and complete relative-time labels without a Chinese gap", async () => {
    const { relativeTimeSuffix, joinRelativeTime } = await import("./display.js");
    expect(joinRelativeTime({ value: "3 分钟", suffix: "前" })).toBe("3 分钟前");
    expect(relativeTimeSuffix("前")).toBe("前");
    expect(joinRelativeTime({ value: "刚刚", suffix: null })).toBe("刚刚");
    expect(relativeTimeSuffix(null)).toBe("");
  });
  it("preserves English output and existing upstream tests", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "en" });
    const { displayThreadTitle, displayLabel, joinRelativeTime } = await import("./display.js");
    expect(displayThreadTitle("New thread")).toBe("New thread");
    expect(displayLabel("High")).toBe("High");
    expect(joinRelativeTime({ value: "3m", suffix: "ago" })).toBe("3m ago");
    vi.stubEnv("MODE", "test");
    expect(displayLabel("High")).toBe("High");
  });
  it.each([
    ["default", null],
    ["priority", "fast"],
    ["ultrafast", "ultrafast"],
  ])(
    "retains semantic selection and speed icon for %s while translating the trigger",
    async (id, icon) => {
      const { buildTraitsTriggerDisplay } =
        await import("../apps/web/src/components/chat/TraitsPicker.tsx");
      const descriptors = [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [{ id: "high", label: "High" }],
        },
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          currentValue: id,
          options: [
            { id: "default", label: "Standard" },
            { id: "priority", label: "Fast" },
            { id: "ultrafast", label: "Ultrafast" },
          ],
        },
      ];
      const original = structuredClone(descriptors);
      const result = buildTraitsTriggerDisplay({
        provider: "codex",
        descriptors,
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: false,
      });
      expect(result).toEqual({ label: "高", speedIcon: icon });
      expect(descriptors).toEqual(original);
      const { buildProviderOptionSelectionsFromDescriptors } =
        await import("../packages/shared/src/model.ts");
      expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: id },
      ]);
    },
  );
});
