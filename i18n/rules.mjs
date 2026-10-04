import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import protectedLocations from "./protected-locations.json" with { type: "json" };

export const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
export const sourceRoots = [
  "apps/web/src",
  "apps/desktop/src",
  "packages/client-runtime/src",
  "packages/contracts/src",
  "packages/shared/src",
];

export function inScope(filename) {
  const relative = NodePath.relative(repoRoot, filename.split("?")[0]).replaceAll("\\", "/");
  return (
    sourceRoots.some((root) => relative.startsWith(`${root}/`)) &&
    /\.[cm]?[jt]sx?$/.test(relative) &&
    !/(?:\.test\.|\.spec\.|\.d\.ts$|\.generated\.|\/testing\/|\/__tests__\/|routeTree\.gen\.)/i.test(
      relative,
    ) &&
    // Preloads run in a sandbox, with no main-process runtime or locale store.
    !/apps\/desktop\/src\/(?:.*preload\.|preview\/.*Preload\.|.*Worker\.|boot\.|compileCache\.)/i.test(
      relative,
    )
  );
}

export const uiProperties = new Set([
  "label",
  "title",
  "description",
  "placeholder",
  "message",
  "tooltip",
  "text",
  "hint",
  "subtitle",
  "summary",
  "heading",
  "emptyText",
  "emptyMessage",
  "confirmLabel",
  "cancelLabel",
  "actionLabel",
  "detail",
  "buttonLabel",
  "submitLabel",
  "loadingText",
  "errorMessage",
  "successMessage",
  "helperText",
  "searchPlaceholder",
  "emptyLabel",
  "loadingLabel",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "alt",
  "children",
]);
export const nonTextProperties = new Set([
  "className",
  "class",
  "key",
  "id",
  "type",
  "variant",
  "size",
  "href",
  "src",
  "role",
  "name",
  "value",
  "defaultValue",
  "htmlFor",
  "to",
  "path",
  "command",
  "method",
  "url",
  "style",
  "color",
  "icon",
  "testId",
  "targetId",
  "accelerator",
  "selector",
  "searchTerms",
  "lang",
  "code",
  "script",
  "expression",
  "executable",
  "args",
  "cwd",
  "env",
]);
const stringMethods = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "lastIndexOf",
  "match",
  "matchAll",
  "replace",
  "replaceAll",
  "split",
  "search",
  "test",
  "exec",
]);
const comparisonOperators = new Set(["===", "!==", "==", "!=", "in", "<", ">", "<=", ">="]);
const expressionWrappers = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

export function propertyName(node) {
  return node?.type === "Identifier" || node?.type === "JSXIdentifier"
    ? node.name
    : node?.type === "StringLiteral"
      ? node.value
      : undefined;
}

function memberNames(node) {
  if (!node) return [];
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression")
    return memberNames(node.callee);
  if (node.type === "MetaProperty") return [`${node.meta.name}.${node.property.name}`];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    return [...memberNames(node.object), propertyName(node.property) ?? ""];
  }
  return [];
}

function protectedCall(path) {
  const callee = path.node.callee;
  const names = memberNames(callee);
  const leaf = names.at(-1) ?? "";
  const root = names[0] ?? "";
  // Imported aliases of effect/Schema are protected as well as Schema.*.
  const binding = path.scope.getBinding(root);
  const source = binding?.path.parentPath?.node.source?.value;
  if (
    source === "effect/Schema" ||
    source === "@effect/schema/Schema" ||
    (source === "effect" && binding?.path.node.imported?.name === "Schema") ||
    root.endsWith("Schema") ||
    /^(?:Literal|Literals)$/.test(leaf)
  )
    return "schema";
  if (
    root === "console" ||
    /logger/i.test(root) ||
    root === "Log" ||
    /^log(?:Info|Warning|Error|Debug|Trace|Fatal)?$/.test(leaf) ||
    (root === "Effect" && leaf.startsWith("log"))
  )
    return "logging";
  if (stringMethods.has(leaf)) return "string-operation";
  if (callee?.type === "Import" || root === "require") return "module-source";
  if (root === "import.meta" || root === "URL") return "module-url";
  if (
    [
      "executeJavaScript",
      "executeJavaScriptInIsolatedWorld",
      "evaluate",
      "evaluateHandle",
    ].includes(leaf)
  )
    return "injected-code";
  if (["__t", "__tf"].includes(leaf)) return "already-translated";
  return null;
}

/** Protection wins over the dictionary, including through nested expressions. */
export function protectionReason(path) {
  let crossedJsxElement = false;
  for (
    let child = path, parent = path.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    const node = parent.node;
    if (node.type === "JSXElement" || node.type === "JSXFragment") crossedJsxElement = true;
    if (
      node.type.startsWith("TS") &&
      !(expressionWrappers.has(node.type) && child.key === "expression")
    )
      return "typescript";
    if (
      /^(?:Import|Export)/.test(node.type) &&
      (child.key === "source" || node.type === "ImportDeclaration")
    )
      return "module-source";
    if (node.type === "TaggedTemplateExpression") return "tagged-template";
    if (node.type === "TemplateLiteral") return "template-expression";
    if (node.type === "BinaryExpression" && comparisonOperators.has(node.operator))
      return "comparison";
    if (node.type === "SwitchCase" && child.key === "test") return "switch-case";
    if (node.type === "ConditionalExpression" && child.key === "test") return "condition";
    if (
      ["ObjectProperty", "ObjectMethod", "ClassProperty", "ClassMethod"].includes(node.type) &&
      child.key === "key"
    )
      return "property-key";
    if (
      (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      child.key === "property"
    )
      return "property-key";
    // A control={<Button>Save</Button>} prop owns markup, not its descendants' text.
    if (node.type === "JSXAttribute" && !crossedJsxElement) {
      const name = propertyName(node.name);
      if (!uiProperties.has(name)) return `jsx-non-text:${name}`;
    }
    if (node.type === "ObjectProperty" && child.key === "value" && !crossedJsxElement) {
      const name = propertyName(node.key);
      if (nonTextProperties.has(name) || name?.startsWith("data-")) return `non-text:${name}`;
    }
    if (
      node.type === "CallExpression" ||
      node.type === "OptionalCallExpression" ||
      node.type === "NewExpression"
    ) {
      const reason = protectedCall(parent);
      if (reason) return reason;
    }
  }
  return null;
}

/** Babel/React JSX whitespace semantics; do not collapse significant same-line spaces. */
export function jsxText(value) {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i])) lastNonEmptyLine = i;
  return lines
    .map((line, i) => {
      let text = line.replaceAll("\t", " ");
      if (i !== 0) text = text.replace(/^ +/, "");
      if (i !== lines.length - 1) text = text.replace(/ +$/, "");
      return text && i !== lastNonEmptyLine ? `${text} ` : text;
    })
    .join("");
}

function uiContext(path) {
  if (path.isJSXText()) return "jsx-text";
  let child = path;
  let parent = path.parentPath;
  while (parent) {
    const node = parent.node;
    if (
      (expressionWrappers.has(node.type) && child.key === "expression") ||
      (node.type === "ConditionalExpression" && child.key !== "test") ||
      (node.type === "LogicalExpression" && ["??", "||", "&&"].includes(node.operator))
    ) {
      child = parent;
      parent = parent.parentPath;
      continue;
    }
    if (node.type === "JSXExpressionContainer") {
      const attribute = parent.parentPath;
      return attribute.isJSXAttribute()
        ? uiProperties.has(propertyName(attribute.node.name))
          ? "jsx-attr"
          : null
        : "jsx-text";
    }
    if (node.type === "JSXAttribute" && uiProperties.has(propertyName(node.name)))
      return "jsx-attr";
    if (
      node.type === "ObjectProperty" &&
      child.key === "value" &&
      uiProperties.has(propertyName(node.key))
    )
      return "prop";
    // Electron dialog button arrays contain UI labels, not protocol values.
    if (
      node.type === "ArrayExpression" &&
      parent.parentPath?.isObjectProperty() &&
      propertyName(parent.parentPath.node.key) === "buttons"
    )
      return "prop";
    return null;
  }
  return null;
}

export const isMultiword = (value) => /[A-Za-z][A-Za-z'’-]*\s+[A-Za-z]/.test(value);

/** The extractor and transformer call this exact classifier on the same AST. */
export function classify(
  path,
  { filename = path.hub?.file?.opts.filename, describePlaceholders = true } = {},
) {
  const node = path.node;
  const template = path.isTemplateLiteral();
  const raw = path.isJSXText()
    ? jsxText(node.value)
    : template
      ? node.quasis
          .map(
            (part, i) =>
              (part.value.cooked ?? part.value.raw) + (i < node.expressions.length ? `{${i}}` : ""),
          )
          .join("")
      : node.value;
  if (typeof raw !== "string" || !/[A-Za-z]/.test(raw)) return null;
  const key = raw.trim();
  if (!key) return null;
  const context = uiContext(path);
  const relative = filename
    ? NodePath.relative(repoRoot, filename.split("?")[0]).replaceAll("\\", "/")
    : "";
  const override = protectedLocations.find((entry) => entry.file === relative && entry.key === key);
  const reason =
    protectionReason(path) ??
    (override ? `reviewed:${override.reason}` : null) ??
    (template && node.quasis.some((part) => /\{\d+\}/.test(part.value.cooked ?? part.value.raw))
      ? "literal-placeholder-collision"
      : null);
  const multiword = isMultiword(template ? raw.replace(/\{\d+\}/g, " ") : raw);
  const eligible = !reason && (context !== null || multiword);
  return {
    key,
    raw,
    eligible,
    category: template ? "template" : (context ?? "multiword-literal"),
    context: context ?? "multiword-literal",
    reason: reason ?? (eligible ? null : "single-word-outside-ui"),
    // Short snippets are translator context, never evaluated by extraction.
    placeholders:
      template && describePlaceholders
        ? path.get("expressions").map((expr, i) => ({
            token: `{${i}}`,
            expression: expr.toString().slice(0, 240),
          }))
        : [],
    review:
      !eligible &&
      (context !== null ||
        multiword ||
        /(?:label|title|text|message|name|caption|summary|description)/i.test(
          propertyName(path.parentPath?.node.key) ?? propertyName(path.parentPath?.node.id) ?? "",
        )),
  };
}
