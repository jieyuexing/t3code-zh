import dictionary from "./zh-CN.json" with { type: "json" };
import { createTranslator, localeKey, normalizeLocale } from "./core.js";

// Synchronous module initialization precedes evaluation of every translated importer.
let locale = "zh-CN";
try {
  locale = normalizeLocale(globalThis.localStorage?.getItem(localeKey));
} catch {
  // Storage may be unavailable in a private or embedded browser.
}
if (typeof document !== "undefined") document.documentElement.lang = locale;
export const getLocale = () => locale;
export const { __t, __tf, __th } = createTranslator(dictionary, getLocale);

/** Persist both clients before reloading; a failed write must stay visible to the user. */
export async function changeLocale(next, bridge, reload = () => globalThis.location.reload()) {
  if (next !== "en" && next !== "zh-CN") throw new Error("Unsupported language");
  const storage = globalThis.localStorage;
  const previous = storage.getItem(localeKey);
  storage.setItem(localeKey, next);
  try {
    await bridge?.setLocale?.(next);
  } catch (error) {
    if (previous === null) storage.removeItem(localeKey);
    else storage.setItem(localeKey, previous);
    throw error;
  }
  locale = next;
  reload();
}
