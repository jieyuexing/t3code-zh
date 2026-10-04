/** Locale values are intentionally independent of a server or environment. */
export const localeKey = "t3zh.locale";
export const normalizeLocale = (value) => (value === "en" ? "en" : "zh-CN");

export function createTranslator(dictionary, getLocale) {
  const translations = new Map(Object.entries(dictionary));
  function __t(raw, override) {
    if (getLocale() === "en") return raw;
    const key = raw.trim();
    const translated = override ?? translations.get(key);
    if (translated === undefined || key === "") return raw;
    const start = raw.length - raw.trimStart().length;
    return raw.slice(0, start) + translated + raw.slice(start + key.length);
  }
  function __tf(raw, args, override) {
    return __t(raw, override).replace(/\{(\d+)\}/g, (token, index) =>
      Number(index) < args.length ? String(args[Number(index)]) : token,
    );
  }
  function __th(raw, args, segments) {
    const fill = (text) =>
      text.replace(/\{(\d+)\}/g, (token, index) =>
        Number(index) < args.length ? args[Number(index)] : token,
      );
    if (getLocale() === "en") return fill(raw);
    let result = "";
    let cursor = 0;
    for (const segment of segments) {
      result += fill(raw.slice(cursor, segment.start));
      if (segment.translation === undefined && !translations.has(segment.text.trim())) {
        result += fill(raw.slice(segment.start, segment.end));
      } else {
        const translated = __tf(
          segment.text,
          segment.indices.map((index) => args[index]),
          segment.translation,
        );
        result +=
          segment.kind === "script-text"
            ? JSON.stringify(translated).replaceAll("<", "\\u003c")
            : translated.replace(
                /[&<>"']/g,
                (character) =>
                  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
                    character
                  ],
              );
      }
      cursor = segment.end;
    }
    return (result + fill(raw.slice(cursor))).replace(/<html\b[^>]*>/i, (tag) =>
      /\blang\s*=/i.test(tag)
        ? tag.replace(/\blang\s*=\s*(["'])[^"']*\1/i, 'lang="zh-CN"')
        : tag.replace(/<html\b/i, '<html lang="zh-CN"'),
    );
  }
  return { __t, __tf, __th };
}
