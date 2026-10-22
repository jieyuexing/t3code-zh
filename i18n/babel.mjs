import * as NodeModule from "node:module";

// Reuse the locked Babel dependency of the web router plugin; no fork dependency.
const webRequire = NodeModule.createRequire(new URL("../apps/web/package.json", import.meta.url));
const routerRequire = NodeModule.createRequire(webRequire.resolve("@tanstack/router-plugin"));
export const babel = routerRequire("@babel/core");
