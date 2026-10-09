#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

// 由 build-desktop-zh 的同一盖章/恢复事务调用；两个目标串行且各自立即归档。
const { values } = NodeUtil.parseArgs({
  options: Object.fromEntries(
    ["platform", "version", "official-archive", "release-metadata", "sha256sums", "output-dir"].map(
      (name) => [name, { type: "string" }],
    ),
  ),
});
for (const name of [
  "platform",
  "version",
  "official-archive",
  "release-metadata",
  "sha256sums",
  "output-dir",
]) {
  if (!values[name]) throw new Error(`缺少 --${name}`);
}
if (!["linux", "win"].includes(values.platform)) throw new Error("只支持 linux/win x64");
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
let child;
let interrupted;
const forward = (signal) => {
  interrupted = signal;
  child?.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
async function run(command, args) {
  if (interrupted) throw new Error(`构建已中断：${interrupted}`);
  await new Promise((resolve, reject) => {
    child = NodeChildProcess.spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      child = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${command} 失败：${signal ?? code}`));
    });
  });
}
const archiveArgs = [
  "scripts/build-cli-archive.ts",
  "--platform",
  values.platform,
  "--arch",
  "x64",
  "--version",
  values.version,
  ...["official-archive", "release-metadata", "sha256sums", "output-dir"].flatMap((name) => [
    `--${name}`,
    values[name],
  ]),
];
// 下载来源和依赖基线先验失败，不能花完构建时间才发现复用无效。
await run(process.execPath, [...archiveArgs, "--verify-template-only"]);
await run("vp", ["run", "--filter", "t3", "build"]);
await run(process.execPath, [
  "apps/server/scripts/cli.ts",
  "build-exe",
  "--target",
  `${values.platform}-x64`,
  "--verbose",
]);
// tsdown 0.23 的 SEA main 使用绝对路径；用同一已校验的目标 Node 再封装，
// 将 blob 中的源文件名改为仓库相对路径，避免候选泄漏构建者的 home 路径。
const serverConfig = NodeFS.readFileSync(NodePath.join(root, "apps/server/vite.config.ts"), "utf8");
const nodeVersion = serverConfig.match(/const SEA_NODE_VERSION = "([0-9.]+)";/)?.[1];
if (!nodeVersion || process.versions.node !== nodeVersion)
  throw new Error("SEA host must match the pinned target Node");
const hostPlatform = Effect.runSync(HostProcessPlatform);
const cacheRoot =
  hostPlatform === "darwin"
    ? NodePath.join(NodeOS.homedir(), "Library/Caches/tsdown")
    : hostPlatform === "win32"
      ? NodePath.join(
          process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Local"),
          "tsdown/Caches",
        )
      : NodePath.join(
          process.env.XDG_CACHE_HOME ?? NodePath.join(NodeOS.homedir(), ".cache"),
          "tsdown",
        );
const executable = NodePath.join(
  cacheRoot,
  "node",
  `v${nodeVersion}`,
  `${values.platform}-x64`,
  values.platform === "win" ? "node.exe" : "node",
);
const seaConfig = NodePath.join(root, "apps/server/dist-exe/zh-sea-config.json");
NodeFS.writeFileSync(
  seaConfig,
  JSON.stringify({
    main: "apps/server/dist-exe/bin.mjs",
    mainFormat: "module",
    executable,
    output: `apps/server/dist-exe/t3-${values.platform}-x64${values.platform === "win" ? ".exe" : ""}`,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }),
);
try {
  await run(process.execPath, ["--build-sea", seaConfig]);
} finally {
  NodeFS.unlinkSync(seaConfig);
}
await run(process.execPath, archiveArgs);
