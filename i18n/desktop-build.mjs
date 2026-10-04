import * as NodeURL from "node:url";
import { babel } from "./babel.mjs";
import plugin from "./plugin.mjs";
import { inScope } from "./rules.mjs";

/** vp pack accepts Rolldown plugins; run Babel before its TypeScript lowering. */
export function desktopI18nPlugin() {
  return {
    name: "t3zh-desktop",
    enforce: "pre",
    async transform(code, id) {
      if (process.env.VITEST || !inScope(id)) return null;
      const result = await babel.transformAsync(code, {
        filename: id,
        configFile: false,
        babelrc: false,
        sourceMaps: true,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [
          [
            plugin,
            { runtime: NodeURL.fileURLToPath(new URL("./desktop-runtime.js", import.meta.url)) },
          ],
        ],
      });
      return result ? { code: result.code, map: result.map } : null;
    },
  };
}
