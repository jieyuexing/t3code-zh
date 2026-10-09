#!/usr/bin/env node
/* eslint-disable t3code/no-global-process-runtime -- Dependency-free build bootstrap also runs in isolated wrapper fixtures. */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as NodePath from "node:path";
import {
  sourceIdentity,
  sameSource,
  fileIdentity,
  artifactSpec,
  readJson,
  writeJson,
} from "./release-source-zh.mjs";

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
const { values } = NodeUtil.parseArgs({
  options: {
    "windows-cross-candidate": { type: "boolean", default: false },
    ...Object.fromEntries(
      [
        "platform",
        "target",
        "arch",
        "wsl-runtime",
        "official-archive",
        "release-metadata",
        "sha256sums",
        "output-dir",
      ].map((name) => [name, { type: "string" }]),
    ),
  },
});
const platform = values.platform ?? "mac";
const target = values.target ?? "dmg";
const arch = values.arch ?? "arm64";
if (
  values["windows-cross-candidate"] &&
  (platform !== "win" || target !== "nsis" || arch !== "x64" || process.platform === "win32")
)
  throw new Error("--windows-cross-candidate only supports non-Windows win/nsis/x64");
if (
  !["mac/dmg/arm64", "win/nsis/x64", "linux/archive/x64", "win/archive/x64"].includes(
    `${platform}/${target}/${arch}`,
  )
) {
  throw new Error("只支持 mac/dmg/arm64、win/nsis/x64 和 linux|win/archive/x64。");
}
if (target === "archive") {
  for (const name of ["official-archive", "release-metadata", "sha256sums", "output-dir"]) {
    if (!values[name]) throw new Error(`缺少 --${name}`);
  }
  if (values["wsl-runtime"]) throw new Error("archive 不接受 --wsl-runtime");
} else {
  for (const name of ["official-archive", "release-metadata", "sha256sums"]) {
    if (values[name]) throw new Error(`${target} 不接受 --${name}`);
  }
  if (platform === "win" && !values["wsl-runtime"])
    throw new Error("Windows NSIS 必须提供 --wsl-runtime");
  if (platform === "mac" && values["wsl-runtime"]) throw new Error("DMG 不接受 --wsl-runtime");
}

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

const source = sourceIdentity(root);
const kind = target === "archive" ? (platform === "win" ? "windows" : "linux") : target;
const spec = artifactSpec(version, kind);
const outputDir = NodePath.resolve(
  values["output-dir"] ?? process.env.T3CODE_DESKTOP_OUTPUT_DIR ?? NodePath.join(root, "release"),
);
const artifact = NodePath.join(outputDir, spec.name);
if (NodeFS.existsSync(artifact) || NodeFS.existsSync(`${artifact}.candidate.json`))
  throw new Error("Candidate output already exists; use a new output directory");
const upstreamCommit = NodeChildProcess.execFileSync("git", ["rev-parse", `v${version}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();
let embeddedWslSha256;
if (values["wsl-runtime"]) {
  const wsl = readJson(`${values["wsl-runtime"]}.candidate.json`);
  const actual = fileIdentity(values["wsl-runtime"]);
  if (
    wsl.kind !== "linux" ||
    wsl.version !== version ||
    wsl.sha256 !== actual.sha256 ||
    wsl.bytes !== actual.bytes ||
    !sameSource(source, wsl.source)
  )
    throw new Error("WSL candidate must have identical source/version/hash; rebuild the set");
  embeddedWslSha256 = actual.sha256;
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
  if (target === "archive") {
    await run([
      "scripts/build-cli-zh.mjs",
      "--platform",
      platform,
      "--version",
      version,
      ...["official-archive", "release-metadata", "sha256sums", "output-dir"].flatMap((name) => [
        `--${name}`,
        values[name],
      ]),
    ]);
  } else {
    await run([
      "scripts/build-desktop-artifact.ts",
      "--platform",
      platform,
      "--target",
      target,
      "--arch",
      arch,
      "--build-version",
      version,
      "--output-dir",
      outputDir,
      ...(values["windows-cross-candidate"] ? ["--windows-cross-candidate"] : []),
      ...(values["wsl-runtime"] ? ["--wsl-runtime", values["wsl-runtime"]] : []),
    ]);
  }
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

if (!sameSource(source, sourceIdentity(root)))
  throw new Error("Concurrent source change; candidate identity not issued");
writeJson(`${artifact}.candidate.json`, {
  schema: 1,
  version,
  upstreamTag: `v${version}`,
  upstreamCommit,
  source,
  kind,
  ...spec,
  ...fileIdentity(artifact),
  structure: "passed",
  native: "pending",
  ...(embeddedWslSha256 ? { embeddedWslSha256 } : {}),
});
console.log(
  `[zh-candidate] ${spec.name}: structure passed; target validation pending; NOT release-ready`,
);
