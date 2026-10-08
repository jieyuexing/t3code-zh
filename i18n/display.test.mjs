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
  it("translates usage notice messages without translating environment or account labels", async () => {
    const { displayUsageNotice } = await import("./display.js");
    expect(
      displayUsageNotice("Jieyue的MacBook Pro · Grok: Grok could not read usage limits."),
    ).toBe("Jieyue的MacBook Pro · Grok: Grok 无法读取用量限额。");
    expect(
      displayUsageNotice(
        "omarchy · Codex: Codex CLI is not authenticated. Run `codex login` and try again.",
      ),
    ).toBe("omarchy · Codex: Codex CLI 未登录。请运行 `codex login` 后重试。");
    expect(displayUsageNotice("High · Codex: Codex could not read usage (JSON-RPC -32000).")).toBe(
      "High · Codex: Codex 无法读取用量（JSON-RPC -32000）。",
    );
    expect(displayUsageNotice("Grok could not read usage limits.")).toBe("Grok 无法读取用量限额。");
    expect(displayUsageNotice("Local · Grok: Grok usage-limit check timed out.")).toBe(
      "Local · Grok: Grok 读取用量限额超时。",
    );
    expect(displayUsageNotice("Local · Grok: Grok billing returned HTTP 418.")).toBe(
      "Local · Grok: Grok 计费服务返回 HTTP 418。",
    );
    expect(displayUsageNotice("Custom: unknown provider response")).toBe(
      "Custom: unknown provider response",
    );
    expect(displayUsageNotice("High")).toBe("High");
    expect(displayUsageNotice("Prefix Grok could not read usage limits.")).toBe(
      "Prefix Grok could not read usage limits.",
    );
  });
  it("translates quota window names while preserving model suffixes and unknown labels", async () => {
    const { displayUsageWindowLabel } = await import("./display.js");
    expect(displayUsageWindowLabel("Session")).toBe("会话");
    expect(displayUsageWindowLabel("Weekly")).toBe("每周");
    expect(displayUsageWindowLabel("Weekly · Fable")).toBe("每周 · Fable");
    expect(displayUsageWindowLabel("Monthly")).toBe("每月");
    expect(displayUsageWindowLabel("Subscription")).toBe("订阅");
    expect(displayUsageWindowLabel("Weekly budget")).toBe("Weekly budget");
  });
  it("keeps usage messages and windows in English for English locale and upstream tests", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "en" });
    const { displayUsageNotice, displayUsageWindowLabel } = await import("./display.js");
    const notice = "Local · Grok: Grok could not read usage limits.";
    expect(displayUsageNotice(notice)).toBe(notice);
    expect(displayUsageNotice("Local · Grok: Grok billing returned HTTP 418.")).toBe(
      "Local · Grok: Grok billing returned HTTP 418.",
    );
    expect(displayUsageWindowLabel("Weekly · Fable")).toBe("Weekly · Fable");
    vi.stubEnv("MODE", "test");
    expect(displayUsageNotice(notice)).toBe(notice);
    expect(displayUsageWindowLabel("Weekly")).toBe("Weekly");
  });
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
    ["default", "高"],
    ["priority", "高 快速"],
    ["ultrafast", "高 超快"],
  ])(
    "retains semantic selection for %s while translating the combined reasoning and speed label",
    async (id, label) => {
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
      expect(result).toEqual({ label });
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
