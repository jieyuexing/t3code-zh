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
  "tooltipText",
  "sendDisabledReason",
  "disabledReason",
  "pickDisabledReason",
  "ariaLabel",
  "accessibleLabel",
  "openAriaLabel",
  "triggerAriaLabel",
  "pendingLabel",
  "copiedLabel",
  "copyLabel",
  "noMatchLabel",
  "footerActionLabel",
  "kindLabel",
  "searchLabel",
  "errorLabel",
  "truncatedLabel",
  "hostLabel",
  "rightPanelUnavailableLabel",
  "expandLabel",
  "hideTooltip",
  "revealTooltip",
  "buttonText",
  "caption",
  "eyebrow",
  "displayName",
  "seedName",
  "accessibilityLabel",
  "continueLabel",
  "currentLabel",
  "sectionTitle",
  "triggerLabel",
]);
// These props contain controls or presentation records. Only their independently
// recognized text fields are UI; IDs, values and arbitrary strings still are not.
const uiContainers = new Set(["inputProps", "permissions", "presentation", "size", "status"]);
const textArrays = new Set(["buttons", "labels", "headers", "steps"]);
const componentTextProps = new Map([
  ["PullRequestCopyableCode", new Set(["target"])],
  ["NetworkAccessDescription", new Set(["fallback"])],
  ["SettingsRow", new Set(["status"])],
  ["PullRequestsUnavailableState", new Set(["error"])],
  ["SnapShotSetupDialog", new Set(["error"])],
  ["ThreadErrorBanner", new Set(["error"])],
]);

function jsxName(attribute) {
  return propertyName(attribute.parentPath?.node.name);
}

function isTextAttribute(attribute) {
  const name = propertyName(attribute.node.name);
  return uiProperties.has(name) || componentTextProps.get(jsxName(attribute))?.has(name);
}

function labelBinding(name) {
  return (
    name === "summary" ||
    /(?:Label|Title|Caption|Tooltip|Placeholder|Description|Message|Heading)s?$/.test(name ?? "") ||
    /(?:^|_)(?:LABEL|TITLE|CAPTION|TOOLTIP|PLACEHOLDER|DESCRIPTION|MESSAGE|HEADING)S?(?:_|$)/.test(
      name ?? "",
    )
  );
}

// Known presentation APIs; argument positions matter (e.g. a copied URL is data).
function textArgument(call, child) {
  if (child.listKey !== "arguments") return false;
  const names = memberNames(call.node.callee);
  const leaf = names.at(-1);
  if (child.key === 0) {
    if (["alert", "confirm", "prompt", "Notification"].includes(leaf)) return true;
    if (names[0] === "toast" && ["success", "error", "info", "warning", "message"].includes(leaf))
      return true;
    if (/^set(?:[A-Z]\w*)?(?:Error|Message)$/.test(leaf ?? "")) return true;
    if (
      leaf === "createProfile" &&
      call.scope.getBinding(leaf)?.path.node.init?.params?.[0]?.name === "baseName"
    )
      return true;
    if (["runThreadCommand", "runProjectCloneAction", "runCommand"].includes(leaf)) {
      // Only local wrappers whose first parameter explicitly describes UI copy.
      const binding = call.scope.getBinding(leaf);
      const fn = binding?.path.isFunctionDeclaration()
        ? binding.path.node
        : binding?.path.node.init;
      const wrapped = fn?.type === "CallExpression" ? fn.arguments[0] : fn;
      return /(?:title|message|label)/i.test(propertyName(wrapped?.params?.[0]) ?? "");
    }
  }
  return (
    ["copyReference", "writeTextToClipboard", "booleanStateLabel"].includes(leaf) && child.key === 1
  );
}
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
  "headers",
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
export function protectionReason(path, filename) {
  let crossedJsxElement = false;
  const context = uiContext(path);
  let templateExpression = false;
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
    if (node.type === "TemplateLiteral") {
      const outer = classify(parent, { filename, describePlaceholders: false });
      // The transformer skips the children of a rewritten template. Children of
      // interpolation-only wrappers are still visited and can be translated.
      if (outer?.reason?.startsWith("reviewed:")) return outer.reason;
      if (outer?.eligible) templateExpression = true;
    }
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
      const nestedText =
        context &&
        (textArrays.has(name) ||
          uiContainers.has(name) ||
          /^on[A-Z]/.test(name ?? "") ||
          name === "testConnection" ||
          (name === "value" &&
            path.findParent(
              (ancestor) =>
                ancestor.isCallExpression() &&
                memberNames(ancestor.node.callee).at(-1) === "booleanStateLabel",
            )));
      if (!isTextAttribute(parent) && !nestedText) return `jsx-non-text:${name}`;
    }
    if (node.type === "ObjectProperty" && child.key === "value" && !crossedJsxElement) {
      const name = propertyName(node.key);
      if (name === "name" && isDisplayName(parent)) continue;
      if (isLabelTableValue(parent) && !["className", "style", "id", "key"].includes(name))
        continue;
      if (name === "code" && isLabelFallback(path)) continue;
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
  return templateExpression ? "template-expression" : null;
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
  if (isLabelFallback(path)) return "prop";
  let child = path;
  let parent = path.parentPath;
  while (parent) {
    const node = parent.node;
    if (
      (expressionWrappers.has(node.type) && child.key === "expression") ||
      node.type === "TemplateLiteral" ||
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
        ? isTextAttribute(attribute)
          ? "jsx-attr"
          : null
        : "jsx-text";
    }
    if (node.type === "JSXAttribute" && isTextAttribute(parent)) return "jsx-attr";
    if (
      node.type === "ObjectProperty" &&
      child.key === "value" &&
      (uiProperties.has(propertyName(node.key)) ||
        isDisplayName(parent) ||
        isLabelTableValue(parent))
    )
      return "prop";
    if (
      ["CallExpression", "OptionalCallExpression", "NewExpression"].includes(node.type) &&
      textArgument(parent, child)
    )
      return "prop";
    if (
      node.type === "VariableDeclarator" &&
      child.key === "init" &&
      labelBinding(propertyName(node.id))
    )
      return "prop";
    if (
      node.type === "ReturnStatement" ||
      (parent.isArrowFunctionExpression() && child.key === "body")
    ) {
      const fn = parent.isFunction() ? parent : parent.getFunctionParent();
      const name = propertyName(fn?.node.id) ?? propertyName(fn?.parentPath?.node.id);
      if (labelBinding(name)) return "prop";
    }
    // Array elements and record values are text only in named label collections.
    if (
      node.type === "ArrayExpression" ||
      (node.type === "ObjectProperty" && child.key === "value")
    ) {
      let owner =
        node.type === "ArrayExpression" ? parent.parentPath : parent.parentPath?.parentPath;
      while (owner && expressionWrappers.has(owner.node.type)) owner = owner.parentPath;
      if (owner?.isJSXExpressionContainer()) owner = owner.parentPath;
      if (owner?.isCallExpression() && textArgument(owner, parent.parentPath)) return "prop";
      const name =
        propertyName(owner?.node.key) ??
        propertyName(owner?.node.name) ??
        propertyName(owner?.node.id);
      if (
        (textArrays.has(name) &&
          (node.type === "ArrayExpression" || name === "labels") &&
          (owner?.isJSXAttribute() || name === "buttons" || name === "labels")) ||
        labelBinding(name)
      )
        return "prop";
    }
    return null;
  }
  return null;
}

function isLabelFallback(path) {
  const node = path.parentPath?.node;
  return (
    path.key === "right" &&
    node?.type === "LogicalExpression" &&
    ["??", "||"].includes(node.operator) &&
    node.left.type === "CallExpression" &&
    (memberNames(node.left.callee).at(-1) ?? "").endsWith("Label")
  );
}

function isDisplayName(property) {
  if (propertyName(property.node.key) !== "name" || !property.parentPath?.isObjectExpression())
    return false;
  const siblings = property.parentPath.node.properties;
  // Electron filters, media preview names and source-control host presentation.
  if (siblings.some((entry) => ["extensions", "src", "baseUrl"].includes(propertyName(entry.key))))
    return true;
  const id = siblings.find((entry) => propertyName(entry.key) === "id")?.value;
  const fallback = property.node.value;
  return (
    ["DEFAULT_BROWSER_PROFILE_ID", "INCOGNITO_BROWSER_PROFILE_ID"].includes(id?.name) ||
    id?.value === "chat-code-block" ||
    (fallback.type === "LogicalExpression" &&
      ["??", "||"].includes(fallback.operator) &&
      ["MemberExpression", "OptionalMemberExpression"].includes(fallback.left.type) &&
      propertyName(fallback.left.property) === "title")
  );
}

function isLabelTableValue(property) {
  let owner = property.parentPath?.parentPath;
  while (owner && expressionWrappers.has(owner.node.type)) owner = owner.parentPath;
  return owner?.isVariableDeclarator() && labelBinding(propertyName(owner.node.id));
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
  const override = protectedLocations.find(
    (entry) =>
      entry.file === relative &&
      entry.key === key &&
      (entry.line === undefined || entry.line === path.node.loc?.start.line),
  );
  const reason =
    protectionReason(path, filename) ??
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
