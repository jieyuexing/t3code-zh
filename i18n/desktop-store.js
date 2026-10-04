import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { normalizeLocale } from "./core.js";

export function readDesktopLocale(path) {
  try {
    return normalizeLocale(JSON.parse(NodeFS.readFileSync(path, "utf8")).locale);
  } catch {
    return "zh-CN";
  }
}

export function persistDesktopLocale(path, locale) {
  if (locale !== "en" && locale !== "zh-CN") throw new Error("Unsupported language");
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify({ locale })}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, path);
}
