import * as NodePath from "node:path";
import { app } from "electron";
import dictionary from "./zh-CN.json" with { type: "json" };
import { createTranslator } from "./core.js";
import { readDesktopLocale, persistDesktopLocale } from "./desktop-store.js";

// appData is stable before Electron's userData/profile selection. Keep the fork's
// preference separate; tests/dev instances can supply an isolated absolute path.
const preferencePath =
  process.env.T3ZH_LOCALE_FILE ||
  NodePath.join(
    app.getPath("appData"),
    "t3code-zh",
    process.env.VITE_DEV_SERVER_URL ? "locale-dev.json" : "locale.json",
  );
const locale = readDesktopLocale(preferencePath);
// Chromium role labels use startup locale. Persisted switches take effect on restart.
if (!app.isReady()) app.commandLine.appendSwitch("lang", locale === "en" ? "en-US" : "zh-CN");
export const { __t, __tf, __th } = createTranslator(dictionary, () => locale);

export function setDesktopLocale(next) {
  persistDesktopLocale(preferencePath, next);
  // Keep this process internally consistent; module-level labels and native roles
  // cannot all be re-evaluated. The entire main process changes on the next launch.
}
