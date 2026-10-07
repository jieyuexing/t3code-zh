#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const version = NodeChildProcess.execFileSync(
  "git",
  ["describe", "--tags", "--match", "v*-nightly.*", "--abbrev=0"],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .replace(/^v/, "");
if (!/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(version)) {
  throw new Error(`无法识别上游 nightly 版本：${version}`);
}
if (process.argv.length > 2) throw new Error("此入口不接受额外构建参数。");

// Local fork artifacts must remain feed-free. Do not silently inherit CI publishing inputs.
for (const key of [
  "T3CODE_DESKTOP_UPDATE_REPOSITORY",
  "GITHUB_REPOSITORY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "KEYGEN_TOKEN",
  "BITBUCKET_TOKEN",
  "BT_TOKEN",
  "T3CODE_DESKTOP_MOCK_UPDATES",
]) {
  if (process.env[key]?.trim()) throw new Error(`请在未设置 ${key} 的环境中本地打包。`);
}

const { releasePackageFiles } = await import("./update-release-package-versions.ts");
const originals = new Map(
  releasePackageFiles.map((file) => [
    file,
    NodeFS.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
  ]),
);
let child;
let interrupted;
const forwardSignal = (signal) => {
  interrupted = signal;
  child?.kill(signal);
};
const onInterrupt = () => forwardSignal("SIGINT");
const onTerminate = () => forwardSignal("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

async function run(args) {
  if (interrupted) throw new Error(`构建已中断：${interrupted}`);
  await new Promise((resolve, reject) => {
    child = NodeChildProcess.spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, T3CODE_DESKTOP_SKIP_BUILD: "false" },
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      child = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${args[0]} 失败：${signal ?? code}`));
    });
  });
}

let failure;
try {
  console.log(`[zh-desktop] 上游 nightly：${version}`);
  await run(["scripts/update-release-package-versions.ts", version]);
  await run([
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--target",
    "dmg",
    "--arch",
    "arm64",
    "--build-version",
    version,
  ]);
} catch (error) {
  failure = error;
} finally {
  const conflicts = [];
  for (const [file, original] of originals) {
    const path = new URL(`../${file}`, import.meta.url);
    const current = NodeFS.readFileSync(path, "utf8");
    if (current === original) continue;
    const stamped = `${JSON.stringify({ ...JSON.parse(original), version }, null, 2)}\n`;
    if (current !== stamped) {
      conflicts.push(file);
      continue;
    }
    NodeFS.writeFileSync(path, original);
  }
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  if (conflicts.length)
    failure = new AggregateError(
      failure ? [failure] : [],
      `检测到并发修改，未覆盖这些清单：${conflicts.join(", ")}`,
    );
}

if (failure) throw failure;
