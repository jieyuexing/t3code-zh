import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { repoRoot } from "./rules.mjs";

export function readContextDictionary() {
  return JSON.parse(NodeFS.readFileSync(new URL("./zh-CN.context.json", import.meta.url), "utf8"));
}

/** A line-qualified key wins over its file-wide fallback. Protection still wins. */
export function contextTranslation(contexts, filename, key, line) {
  const relative = NodePath.relative(repoRoot, filename.split("?")[0]).replaceAll("\\", "/");
  const entries = contexts[relative];
  if (!entries) return undefined;
  const qualifiedKey = `${key}::line=${line}`;
  if (Object.hasOwn(entries, qualifiedKey)) return entries[qualifiedKey];
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}
