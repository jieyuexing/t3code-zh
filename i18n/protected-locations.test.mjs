import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { babel } from "./babel.mjs";
import { classify, repoRoot } from "./rules.mjs";
import protectedLocations from "./protected-locations.json" with { type: "json" };

describe("audited data producers", () => {
  it.each(protectedLocations)("still protects $key in $file", (entry) => {
    const filename = NodePath.join(repoRoot, entry.file);
    const ast = babel.parseSync(NodeFS.readFileSync(filename, "utf8"), {
      filename,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
    });
    let matches = 0;
    babel.traverse(ast, {
      "StringLiteral|TemplateLiteral|JSXText"(path) {
        const item = classify(path, { filename });
        if (item?.key !== entry.key || (entry.line && path.node.loc.start.line !== entry.line))
          return;
        expect(item.eligible).toBe(false);
        if (item.reason === `reviewed:${entry.reason}`) matches++;
      },
    });
    // A moved/deleted producer requires a new audit after an upstream merge.
    expect(matches).toBeGreaterThan(0);
  });
});
