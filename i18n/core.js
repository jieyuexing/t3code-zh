/** Locale values are intentionally independent of a server or environment. */
export const localeKey = "t3zh.locale";
export const normalizeLocale = (value) => (value === "en" ? "en" : "zh-CN");

export function createTranslator(dictionary, getLocale) {
  const translations = new Map(Object.entries(dictionary));
  function __t(raw) {
    if (getLocale() === "en") return raw;
    const key = raw.trim();
    const translated = translations.get(key);
    if (translated === undefined || key === "") return raw;
    const start = raw.length - raw.trimStart().length;
    return raw.slice(0, start) + translated + raw.slice(start + key.length);
  }
  function __tf(raw, args) {
    return __t(raw).replace(/\{(\d+)\}/g, (token, index) =>
      Number(index) < args.length ? String(args[Number(index)]) : token,
    );
  }
  return { __t, __tf };
}
