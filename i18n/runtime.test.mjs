import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createTranslator, localeKey } from "./core.js";
import { persistDesktopLocale, readDesktopLocale } from "./desktop-store.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
const storage = (initial = null) => {
  const values = new Map(initial === null ? [] : [[localeKey, initial]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

describe("runtime lookup", () => {
  it("keeps leading punctuation and empty plural suffix translations", () => {
    const { __t } = createTranslator({ ", expired": "，已过期", s: "" }, () => "zh-CN");
    expect(__t(" , expired ")).toBe(" ，已过期 ");
    expect(__t("s")).toBe("");
  });
  it("preserves original whitespace, misses and English", () => {
    let locale = "zh-CN";
    const { __t, __tf } = createTranslator(
      { Settings: "设置", "{0} comments{1}": "{0} 条评论", "{0} then {1}": "{1}/{0}" },
      () => locale,
    );
    expect(__t(" \nSettings\t ")).toBe(" \n设置\t ");
    expect(__t("Not translated")).toBe("Not translated");
    expect(__t("  ")).toBe("  ");
    expect(__tf(" {0} comments{1} ", [3, "s"])).toBe(" 3 条评论 ");
    expect(__tf("{0} then {1}", ["$&", "B"])).toBe("B/$&");
    expect(__tf("missing {0} {1}", [0, false])).toBe("missing 0 false");
    expect(__tf("missing {0}", ["{1}"])).toBe("missing {1}");
    locale = "en";
    expect(__t(" Settings ")).toBe(" Settings ");
    expect(__tf("{0} comments{1}", [2, "s"])).toBe("2 commentss");
  });
  it.each([null, "zh-CN", "bad", "en"])(
    "initializes synchronously from %s before its importer runs",
    async (saved) => {
      vi.stubGlobal("localStorage", storage(saved));
      vi.stubGlobal("document", { documentElement: { lang: "" } });
      const runtime = await import("./runtime.js");
      expect(runtime.getLocale()).toBe(saved === "en" ? "en" : "zh-CN");
      expect(document.documentElement.lang).toBe(runtime.getLocale());
      expect(runtime.__t("Settings")).toBe(saved === "en" ? "Settings" : "设置");
    },
  );
  it("defaults safely when browser storage is blocked", async () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
    });
    expect((await import("./runtime.js")).getLocale()).toBe("zh-CN");
  });
  it("persists to the desktop bridge before reloading, in either direction", async () => {
    const local = storage();
    vi.stubGlobal("localStorage", local);
    const { changeLocale } = await import("./runtime.js");
    const events = [];
    const bridge = {
      setLocale: async (locale) => {
        events.push(locale);
        expect(local.getItem(localeKey)).toBe(locale);
      },
    };
    await changeLocale("en", bridge, () => events.push("reload"));
    await changeLocale("zh-CN", bridge, () => events.push("reload"));
    expect(events).toEqual(["en", "reload", "zh-CN", "reload"]);
  });
  it("rolls back a failed IPC write and never reloads on failed persistence", async () => {
    const local = storage("en");
    vi.stubGlobal("localStorage", local);
    const { changeLocale } = await import("./runtime.js");
    const reload = vi.fn();
    await expect(
      changeLocale(
        "zh-CN",
        {
          setLocale: async () => {
            throw new Error("disk");
          },
        },
        reload,
      ),
    ).rejects.toThrow("disk");
    expect(local.getItem(localeKey)).toBe("en");
    local.setItem = () => {
      throw new Error("quota");
    };
    await expect(changeLocale("zh-CN", undefined, reload)).rejects.toThrow("quota");
    expect(reload).not.toHaveBeenCalled();
  });
  it("persists native preferences in an isolated file and rejects invalid locales", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "i18n-store-"));
    const path = NodePath.join(directory, "locale.json");
    try {
      expect(readDesktopLocale(path)).toBe("zh-CN");
      persistDesktopLocale(path, "en");
      expect(readDesktopLocale(path)).toBe("en");
      expect(() => persistDesktopLocale(path, "invalid")).toThrow("Unsupported");
      expect(readDesktopLocale(path)).toBe("en");
      persistDesktopLocale(path, "zh-CN");
      expect(readDesktopLocale(path)).toBe("zh-CN");
      NodeFS.writeFileSync(path, "broken");
      expect(readDesktopLocale(path)).toBe("zh-CN");
    } finally {
      NodeFS.rmSync(directory, { recursive: true });
    }
  });
});
