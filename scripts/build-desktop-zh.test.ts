// @effect-diagnostics nodeBuiltinImport:off -- Exercise the wrapper subprocess and byte restoration in an isolated fake build tree.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

function fixture(args: string[], mode = "ok", extraEnv: Record<string, string> = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zh-wrapper-"));
  try {
    NodeFS.mkdirSync(NodePath.join(root, "scripts"));
    NodeFS.mkdirSync(NodePath.join(root, "bin"));
    for (const dir of ["apps/server", "apps/web", "apps/desktop"])
      NodeFS.mkdirSync(NodePath.join(root, dir), { recursive: true });
    NodeFS.copyFileSync(
      new URL("./release-source-zh.mjs", import.meta.url),
      NodePath.join(root, "scripts/release-source-zh.mjs"),
    );
    NodeFS.copyFileSync(
      new URL("./build-desktop-zh.mjs", import.meta.url),
      NodePath.join(root, "scripts/build-desktop-zh.mjs"),
    );
    NodeFS.writeFileSync(
      NodePath.join(root, "bin/git"),
      '#!/bin/sh\nif [ "$1" = describe ]; then printf "v0.0.46-nightly.20261008.2833\\n"; else exec /usr/bin/git "$@"; fi\n',
      { mode: 0o755 },
    );
    const original = '{ "name": "fixture", "version": "0.0.45" }\n';
    NodeFS.writeFileSync(NodePath.join(root, "fixture.json"), original);
    NodeFS.writeFileSync(
      NodePath.join(root, "scripts/update-release-package-versions.ts"),
      `
      import * as NodeFS from 'node:fs';
      export const releasePackageFiles = ['fixture.json'];
      if (import.meta.main) NodeFS.writeFileSync('fixture.json', JSON.stringify({...JSON.parse(NodeFS.readFileSync('fixture.json', 'utf8')), version:process.argv[2]},null,2)+'\\n');
    `,
    );
    NodeFS.writeFileSync(
      NodePath.join(root, "scripts/build-desktop-artifact.ts"),
      `
      import * as NodeFS from 'node:fs';
      import * as NodePath from 'node:path';
      const args=process.argv.slice(2), output=args[args.indexOf('--output-dir')+1];
      NodeFS.mkdirSync(output,{recursive:true});
      const suffix=args.includes('win')?'x64.exe':'arm64.dmg';
      NodeFS.writeFileSync(NodePath.join(output,'T3-Code-0.0.46-nightly.20261008.2833-'+suffix),'fixture artifact');
      NodeFS.writeFileSync('called.json',JSON.stringify({args:process.argv.slice(2),version:JSON.parse(NodeFS.readFileSync('fixture.json','utf8')).version}));
      if (process.env.FIXTURE_MODE==='conflict') NodeFS.writeFileSync('fixture.json','concurrent edit');
      if (process.env.FIXTURE_MODE==='signal') process.kill(process.ppid,'SIGTERM');
      if (process.env.FIXTURE_MODE==='fail') process.exit(7);
    `,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      PATH: `${root}/bin:${process.env.PATH}`,
      FIXTURE_MODE: mode,
    };
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY",
      "T3CODE_DESKTOP_UPDATE_REPOSITORY",
    ]) {
      if (!(name in extraEnv)) delete env[name];
    }
    NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "release/\ncalled.json\nwsl/\n");
    const fixtureGit = (...gitArgs: string[]) =>
      NodeChildProcess.execFileSync("/usr/bin/git", gitArgs, { cwd: root, stdio: "pipe" });
    fixtureGit("init");
    fixtureGit("add", ".");
    fixtureGit(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    );
    fixtureGit("tag", "v0.0.46-nightly.20261008.2833");
    if (args.includes("--wsl-runtime")) {
      const wslDir = NodePath.join(root, "wsl");
      NodeFS.mkdirSync(wslDir);
      const wsl = NodePath.join(wslDir, "runtime.tar.gz");
      NodeFS.writeFileSync(wsl, "fixture wsl");
      const manifest = NodeChildProcess.execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import {sourceIdentity,fileIdentity} from './scripts/release-source-zh.mjs'; console.log(JSON.stringify({kind:'linux',version:'0.0.46-nightly.20261008.2833',source:sourceIdentity(process.cwd()),...fileIdentity(${JSON.stringify(wsl)})}));`,
        ],
        { cwd: root, encoding: "utf8" },
      );
      NodeFS.writeFileSync(`${wsl}.candidate.json`, manifest);
      args = args.map((a) => (a === "/tmp/test.tar.gz" ? wsl : a));
    }
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(root, "scripts/build-desktop-zh.mjs"), ...args],
      { cwd: root, env, encoding: "utf8" },
    );
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      restored: NodeFS.readFileSync(NodePath.join(root, "fixture.json"), "utf8"),
      original,
      called: NodeFS.existsSync(NodePath.join(root, "called.json"))
        ? JSON.parse(NodeFS.readFileSync(NodePath.join(root, "called.json"), "utf8"))
        : undefined,
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
}
describe("nightly build wrapper", () => {
  it("keeps the original DMG command and restores exact bytes", () => {
    const r = fixture([]);
    expect(r.status).toBe(0);
    expect(r.restored).toBe(r.original);
    expect(r.called.args).toEqual([
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      "arm64",
      "--build-version",
      "0.0.46-nightly.20261008.2833",
      "--output-dir",
      expect.stringContaining("/release"),
    ]);
    expect(r.called.version).toBe("0.0.46-nightly.20261008.2833");
  });
  it("passes the explicit Windows WSL archive", () => {
    const r = fixture([
      "--platform",
      "win",
      "--target",
      "nsis",
      "--arch",
      "x64",
      "--wsl-runtime",
      "/tmp/test.tar.gz",
    ]);
    expect(r.status).toBe(0);
    expect(r.called.args.slice(-2)).toEqual([
      "--wsl-runtime",
      expect.stringContaining("/wsl/runtime.tar.gz"),
    ]);
    expect(r.restored).toBe(r.original);
  });
  it("explicit cross Windows candidate reports native validation pending", () => {
    const r = fixture([
      "--platform",
      "win",
      "--target",
      "nsis",
      "--arch",
      "x64",
      "--wsl-runtime",
      "/tmp/test.tar.gz",
      "--windows-cross-candidate",
    ]);
    expect(r.status).toBe(0);
    expect(r.called.args).toContain("--windows-cross-candidate");
    expect(r.output).toContain("target validation pending; NOT release-ready");
    expect(r.restored).toBe(r.original);
  });
  it.each(["fail", "signal"])("restores manifests after %s", (mode) => {
    const r = fixture([], mode);
    expect(r.status).not.toBe(0);
    expect(r.restored).toBe(r.original);
  });
  it("refuses to overwrite concurrent manifest changes", () => {
    const r = fixture([], "conflict");
    expect(r.status).not.toBe(0);
    expect(r.restored).toBe("concurrent edit");
    expect(r.output).toContain("检测到并发修改");
  });
  it("rejects publishing inputs before stamping", () => {
    const r = fixture([], "ok", { GH_TOKEN: "fixture-only" });
    expect(r.status).not.toBe(0);
    expect(r.called).toBeUndefined();
    expect(r.restored).toBe(r.original);
  });
  it.each([
    ["--publish", "always"],
    ["--skip-checks"],
    ["--windows-cross-candidate"],
    ["--platform", "win", "--target", "nsis", "--arch", "x64"],
  ])("rejects invalid arguments %s", (...args) => {
    const r = fixture(args);
    expect(r.status).not.toBe(0);
    expect(r.called).toBeUndefined();
    expect(r.restored).toBe(r.original);
  });
});
