import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { classify, classifyAll, inScope } from "./rules.mjs";
import { contextTranslation, readContextDictionary } from "./context.mjs";

export function readDictionary() {
  return JSON.parse(NodeFS.readFileSync(new URL("./zh-CN.json", import.meta.url), "utf8"));
}
export function readIgnore() {
  return JSON.parse(NodeFS.readFileSync(new URL("./ignore.json", import.meta.url), "utf8"));
}

let defaultDictionary;
let defaultIgnore;
let defaultContexts;

export default function i18nPlugin({ types: t }, options = {}) {
  const dictionary = options.dictionary ?? (defaultDictionary ??= readDictionary());
  const ignored = options.ignore ?? (defaultIgnore ??= readIgnore());
  const contexts = options.contexts ?? (defaultContexts ??= readContextDictionary());
  return {
    name: "t3zh-dictionary",
    visitor: {
      Program(program, state) {
        if (process.env.VITEST || options.mode === "test" || !inScope(state.filename ?? "")) return;
        const imports = new Map();
        const runtime =
          options.runtime ?? NodeURL.fileURLToPath(new URL("./runtime.js", import.meta.url));
        // Classify the unmodified tree, just like extraction. Rewriting a local
        // plural helper must not change how its later call sites are recognized.
        const candidates = new WeakMap();
        const context = { filename: state.filename, describePlaceholders: false };
        program.traverse({
          "JSXText|StringLiteral|TemplateLiteral"(path) {
            candidates.set(path.node, {
              outer: classify(path, context),
              items: classifyAll(path, context).map((candidate) => ({
                ...candidate,
                translation: contextTranslation(
                  contexts,
                  state.filename,
                  candidate.key,
                  candidate.line ?? path.node.loc?.start.line,
                ),
              })),
            });
          },
        });
        const translate = (path) => {
          const original = candidates.get(path.node);
          if (!original) return;
          const matches = original.items.filter(
            (candidate) =>
              candidate.eligible &&
              (candidate.translation !== undefined ||
                (Object.hasOwn(dictionary, candidate.key) &&
                  !Object.hasOwn(ignored, candidate.key))),
          );
          if (!matches.length) return;
          const document = !!matches[0].segment;
          const candidate = document ? original.outer : matches[0];
          const template = path.isTemplateLiteral();
          const helper = document ? "__th" : template ? "__tf" : "__t";
          if (!imports.has(helper))
            imports.set(helper, program.scope.generateUidIdentifier(helper));
          const args = [t.stringLiteral(candidate.raw)];
          if (template || document) {
            // Template interpolation coerces each expression before evaluating the next.
            args.push(
              t.arrayExpression(
                (path.node.expressions ?? []).map((expr) =>
                  t.templateLiteral(
                    [
                      t.templateElement({ raw: "", cooked: "" }),
                      t.templateElement({ raw: "", cooked: "" }, true),
                    ],
                    [expr],
                  ),
                ),
              ),
            );
          }
          if (document)
            args.push(
              t.valueToNode(
                matches.map((match) => ({
                  ...match.segment,
                  ...(match.translation !== undefined ? { translation: match.translation } : {}),
                })),
              ),
            );
          else if (candidate.translation !== undefined)
            args.push(t.stringLiteral(candidate.translation));
          const call = t.callExpression(t.cloneNode(imports.get(helper)), args);
          path.replaceWith(
            path.isJSXText() || path.parentPath.isJSXAttribute()
              ? t.jsxExpressionContainer(call)
              : call,
          );
          path.skip();
        };
        // A Program pre-pass runs before React Compiler can lower JSX or hoist strings.
        program.traverse({
          JSXText: translate,
          StringLiteral: translate,
          TemplateLiteral: { exit: translate },
        });
        if (imports.size)
          program.unshiftContainer(
            "body",
            t.importDeclaration(
              [...imports].map(([name, local]) => t.importSpecifier(local, t.identifier(name))),
              t.stringLiteral(runtime),
            ),
          );
      },
    },
  };
}
