import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { classify, inScope } from "./rules.mjs";

export function readDictionary() {
  return JSON.parse(NodeFS.readFileSync(new URL("./zh-CN.json", import.meta.url), "utf8"));
}
export function readIgnore() {
  return JSON.parse(NodeFS.readFileSync(new URL("./ignore.json", import.meta.url), "utf8"));
}

let defaultDictionary;
let defaultIgnore;

export default function i18nPlugin({ types: t }, options = {}) {
  const dictionary = options.dictionary ?? (defaultDictionary ??= readDictionary());
  const ignored = options.ignore ?? (defaultIgnore ??= readIgnore());
  return {
    name: "t3zh-dictionary",
    visitor: {
      Program(program, state) {
        if (process.env.VITEST || options.mode === "test" || !inScope(state.filename ?? "")) return;
        const imports = new Map();
        const runtime =
          options.runtime ?? NodeURL.fileURLToPath(new URL("./runtime.js", import.meta.url));
        const translate = (path) => {
          const candidate = classify(path, {
            filename: state.filename,
            describePlaceholders: false,
          });
          if (
            !candidate?.eligible ||
            !Object.hasOwn(dictionary, candidate.key) ||
            Object.hasOwn(ignored, candidate.key)
          )
            return;
          const template = path.isTemplateLiteral();
          const helper = template ? "__tf" : "__t";
          if (!imports.has(helper))
            imports.set(helper, program.scope.generateUidIdentifier(helper));
          const args = [t.stringLiteral(candidate.raw)];
          if (template) {
            // Template interpolation coerces each expression before evaluating the next.
            args.push(
              t.arrayExpression(
                path.node.expressions.map((expr) =>
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
          TemplateLiteral: translate,
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
