import * as NodeModule from "node:module";

// Reuse the Babel instance already owned by the web build; no fork dependency.
const webRequire = NodeModule.createRequire(new URL("../apps/web/package.json", import.meta.url));
const babelRequire = NodeModule.createRequire(webRequire.resolve("@rolldown/plugin-babel"));
export const babel = babelRequire("@babel/core");
