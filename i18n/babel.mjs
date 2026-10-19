import * as NodeModule from "node:module";

// Reuse the locked Babel peer of the web React plugin; no fork dependency.
const webRequire = NodeModule.createRequire(new URL("../apps/web/package.json", import.meta.url));
const reactRequire = NodeModule.createRequire(webRequire.resolve("@vitejs/plugin-react"));
const babelRequire = NodeModule.createRequire(reactRequire.resolve("@rolldown/plugin-babel"));
export const babel = babelRequire("@babel/core");
