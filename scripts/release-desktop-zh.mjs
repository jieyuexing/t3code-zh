#!/usr/bin/env node
// Publishes the locally built zh DMG as a GitHub Release on the fork.
// Run after `dist:desktop:dmg:arm64:zh` from the commit the DMG was built from:
//   node scripts/release-desktop-zh.mjs [--dry-run] [--dmg <path>]
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const REPO = "jieyuexing/t3code-zh";
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dmgIndex = args.indexOf("--dmg");
const unknown = args.filter(
  (arg, index) => arg !== "--dry-run" && arg !== "--dmg" && index !== dmgIndex + 1,
);
if (unknown.length || (dmgIndex >= 0 && !args[dmgIndex + 1])) {
  throw new Error("用法：node scripts/release-desktop-zh.mjs [--dry-run] [--dmg <路径>]");
}

const version = git("describe", "--tags", "--match", "v*-nightly.*", "--abbrev=0").replace(
  /^v/,
  "",
);
const head = git("rev-parse", "HEAD");
if (git("status", "--porcelain")) throw new Error("工作区不干净，无法确定安装包对应的提交。");
if (!git("branch", "-r", "--contains", head))
  throw new Error(`HEAD ${head.slice(0, 9)} 还没推送到 origin，先推送再发布。`);

const dmg = dmgIndex >= 0 ? args[dmgIndex + 1] : `${root}release/T3-Code-${version}-arm64.dmg`;
if (!NodeFS.existsSync(dmg)) throw new Error(`找不到安装包：${dmg}`);
const sha256 = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(dmg)).digest("hex");

// The update notes live in the body of the latest sync merge commit, between "更新说明" and the trailer.
const merge = git("log", "-1", "--merges", "--format=%H", "--grep=^merge", "HEAD");
const body = merge ? git("log", "-1", "--format=%B", merge) : "";
const start = body.search(/^更新说明/m);
const notesBody =
  start < 0
    ? ""
    : body
        .slice(start)
        .split(/^Co-Authored-By:/m)[0]
        .trim()
        .replace(/^更新说明（(.*)）$/m, "## 更新说明（$1）")
        .replace(/^(桌面 \/ 网页|移动端（需更新商店版才有）|服务端与 Agent)$/gm, "### $1");
if (!notesBody) throw new Error("最近的同步合并提交里没有「更新说明」，先补上再发布。");

const notes = [
  `基于上游 T3 Code \`v${version}\`（[pingdotgg/t3code](https://github.com/pingdotgg/t3code)）的简体中文版，界面默认中文，可在「设置 → 外观」切回英文。`,
  "",
  "## 安装",
  "",
  "- 仅 Apple Silicon（arm64）。下载 DMG，把 `T3 Code (Nightly).app` 拖进「应用程序」；已安装旧版时直接覆盖，数据在 `~/.t3/userdata`，不受影响。",
  "- 安装包是 ad-hoc 签名、未经苹果公证：第一次打开若被拦截，到「系统设置 → 隐私与安全性」点「仍要打开」。",
  `- SHA-256：\`${sha256}\``,
  "",
  notesBody,
  "",
].join("\n");

const tag = `zh-v${version}`;
const notesFile = `${process.env.TMPDIR ?? "/tmp"}/release-notes-${version}.md`;
NodeFS.writeFileSync(notesFile, notes);
const gh = (...ghArgs) =>
  NodeChildProcess.execFileSync("gh", ghArgs, { cwd: root, encoding: "utf8" }).trim();

console.log(`[zh-release] ${tag} ← ${head.slice(0, 9)}，${dmg}（sha256 ${sha256.slice(0, 16)}…）`);
if (dryRun) {
  console.log(notes);
} else {
  // Create a draft first (or reuse the one a failed run left), upload with curl, then publish:
  // `gh release create <file>` uploads at ~80 KB/s through the local proxy, while curl through
  // the same proxy runs at ~3 MB/s.
  const findRelease = () => {
    const found = gh(
      "api",
      `repos/${REPO}/releases`,
      "--jq",
      `[.[] | select(.tag_name == "${tag}")][0]`,
    );
    return found && found !== "null" ? JSON.parse(found) : undefined;
  };
  let release = findRelease();
  if (release && !release.draft) throw new Error(`${tag} 已经发布过，不再重复发布。`);
  if (!release) {
    gh(
      "release",
      "create",
      tag,
      "-R",
      REPO,
      "--draft",
      "--target",
      head,
      "--title",
      `T3 Code 中文版 ${version}`,
      "--notes-file",
      notesFile,
    );
    // A new draft can take a moment to show up in the release list.
    for (let attempt = 0; !release && attempt < 5; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
      release = findRelease();
    }
    if (!release) throw new Error(`草稿 ${tag} 已建，但查不到它的 id，请检查后重跑。`);
  }
  const name = dmg.split("/").pop();
  const findAsset = () => findRelease()?.assets.find((asset) => asset.name === name);
  const matches = (asset) =>
    asset.size === NodeFS.statSync(dmg).size && asset.digest === `sha256:${sha256}`;
  const existing = findAsset();
  if (existing && !matches(existing))
    throw new Error(
      `草稿 ${tag} 里已有不一致的 ${name}（${existing.size}、${existing.digest}），删掉该附件后重跑。`,
    );
  if (!existing) {
    const curlArgs = [
      "--fail",
      "--silent",
      "--show-error",
      "--output",
      "/dev/null",
      "-H",
      `Authorization: Bearer ${gh("auth", "token")}`,
      "-H",
      "Content-Type: application/x-apple-diskimage",
      "--data-binary",
      `@${dmg}`,
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    ];
    const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY;
    if (proxy) curlArgs.unshift("-x", proxy);
    NodeChildProcess.execFileSync("curl", curlArgs);
    // Check what GitHub stored rather than the upload response, which a proxy can cut short.
    const asset = findAsset();
    if (!asset || !matches(asset))
      throw new Error(
        `草稿 ${tag} 已建，但上传的安装包与本地不一致（${asset ? `${asset.size}、${asset.digest}` : "没有附件"}），请检查后重跑。`,
      );
  }
  gh("release", "edit", tag, "-R", REPO, "--draft=false", "--latest");
  console.log(`[zh-release] 已发布：https://github.com/${REPO}/releases/tag/${tag}`);
}
