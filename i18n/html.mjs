export const isHtmlDocument = (raw) => /^\s*<!doctype html\b/i.test(raw ?? "");

/** A bounded tokenizer for our complete inline documents, not an HTML sanitizer.
 * Markup, comments, CSS and scripts stay byte-for-byte source data. The one
 * supported script shape is a literal fallback assigned to .textContent.
 */
export function htmlSegments(raw) {
  const segments = [];
  const add = (start, end, text, kind) => {
    if (!/[A-Za-z]/.test(text.replace(/\{\d+\}/g, ""))) return;
    const indices = [];
    text = text.replace(/\{(\d+)\}/g, (_, index) => {
      indices.push(Number(index));
      return `{${indices.length - 1}}`;
    });
    segments.push({ start, end, text, kind, indices });
  };
  const tokens =
    /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/gi;
  for (const match of raw.matchAll(tokens)) {
    const token = match[0];
    const start = match.index;
    if (match[1]?.toLowerCase() === "script") {
      const offset = token.indexOf(">") + 1;
      // Same-length synthetic identifiers keep AST offsets aligned with HTML.
      // Parsing distinguishes an actual assignment from comments/quoted code.
      const script = token.slice(offset, token.lastIndexOf("</")).replace(/\{(\d+)\}/g, "_$1_");
      let ast;
      try {
        ast = babel.parseSync(script, { configFile: false, babelrc: false });
      } catch {
        continue; // Unsupported embedded script stays untouched for manual review.
      }
      babel.traverse(ast, {
        AssignmentExpression(path) {
          const { left, right } = path.node;
          if (
            left.type !== "MemberExpression" ||
            left.computed ||
            left.property.name !== "textContent" ||
            right.type !== "LogicalExpression" ||
            right.operator !== "||" ||
            !["Identifier", "MemberExpression"].includes(right.left.type) ||
            right.right.type !== "StringLiteral"
          )
            return;
          const literal = right.right;
          const original = token.slice(offset + literal.start, offset + literal.end);
          if (/\{\d+\}/.test(original)) return;
          add(
            start + offset + literal.start,
            start + offset + literal.end,
            literal.value,
            "script-text",
          );
        },
      });
    } else if (match[1] || token.startsWith("<!--")) {
      continue;
    } else if (token.startsWith("<")) {
      for (const attribute of token.matchAll(
        /\s(?:title|alt|placeholder|aria-label|aria-description)\s*=\s*(["'])([\s\S]*?)\1/gi,
      )) {
        const text = attribute[2];
        const offset = start + attribute.index + attribute[0].length - text.length - 1;
        add(offset, offset + text.length, text, "attribute");
      }
    } else {
      add(start, start + token.length, token, "text");
    }
  }
  return segments;
}
import { babel } from "./babel.mjs";
