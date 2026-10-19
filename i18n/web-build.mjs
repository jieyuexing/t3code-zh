import { babel } from "./babel.mjs";
import plugin from "./plugin.mjs";
import { inScope } from "./rules.mjs";

/** Translate source before the upstream native React Compiler lowers JSX. */
export function webI18nPlugin(mode) {
  return {
    name: "t3zh-web",
    enforce: "pre",
    async transform(code, id) {
      if (process.env.VITEST || mode === "test" || !inScope(id)) return null;
      const result = await babel.transformAsync(code, {
        filename: id,
        configFile: false,
        babelrc: false,
        sourceMaps: true,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [[plugin, { mode }]],
      });
      return result ? { code: result.code, map: result.map } : null;
    },
  };
}
