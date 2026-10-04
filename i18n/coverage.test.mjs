import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { extract } from "./coverage.ts";
import { repoRoot } from "./rules.mjs";

describe("coverage CLI", () => {
  it("fails missing coverage, then succeeds with a complete scoped dictionary through the same CLI", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "i18n-coverage-"));
    try {
      const scope = NodePath.join(repoRoot, "apps/desktop/src/window/DesktopApplicationMenu.ts");
      const { candidates } = extract([scope]);
      expect(candidates.length).toBeGreaterThan(0);
      const dictionary = NodePath.join(directory, "dictionary.json");
      const output = NodePath.join(directory, "candidates.json");
      const review = NodePath.join(directory, "review.json");
      const args = [
        "i18n/coverage.ts",
        "--scope",
        scope,
        "--dictionary",
        dictionary,
        "--candidates",
        output,
        "--review",
        review,
      ];
      NodeFS.writeFileSync(dictionary, "{}");
      const failed = NodeChildProcess.spawnSync(process.execPath, args, {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(failed.status).toBe(1);
      expect(JSON.parse(failed.stdout).length).toBeGreaterThan(0);
      expect(JSON.parse(NodeFS.readFileSync(output, "utf8"))).toEqual(candidates);
      NodeFS.writeFileSync(
        dictionary,
        JSON.stringify(Object.fromEntries(candidates.map(({ key }) => [key, "测试"])), null, 2),
      );
      const passed = NodeChildProcess.spawnSync(process.execPath, args, {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(passed.status).toBe(0);
      expect(JSON.parse(passed.stdout)).toEqual([]);
      expect(JSON.parse(passed.stderr).missing).toBe(0);
      expect(Array.isArray(JSON.parse(NodeFS.readFileSync(review, "utf8")))).toBe(true);
      const excluded = JSON.parse(NodeFS.readFileSync(review, "utf8"));
      for (const item of excluded) {
        expect(Object.values(item.reasons).reduce((sum, count) => sum + count, 0)).toBe(
          item.occurrenceCount,
        );
      }
      const reasonCounts = Object.values(JSON.parse(passed.stderr).reviewByReason);
      expect(reasonCounts.reduce((sum, entry) => sum + entry.occurrences, 0)).toBe(
        excluded.reduce((sum, item) => sum + item.occurrenceCount, 0),
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true });
    }
  });
});
