#!/usr/bin/env node
// 完整套装的唯一发布入口。所有本地检查先于任何 GitHub 写入。
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import {
  readJson,
  fileIdentity,
  sourceIdentity,
  sameSource,
  git,
  artifactSpec,
  assertCandidate,
  sha256,
} from "./release-source-zh.mjs";
import { verifyReceipt, checkFiles, parse7zListing, inventory } from "./release-validation-zh.mjs";

const REPO = "jieyuexing/t3code-zh";
export function releaseTag(version, explicit) {
  const base = `zh-v${version}`;
  if (
    explicit !== undefined &&
    explicit !== base &&
    !new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-r[1-9][0-9]*$`).test(explicit)
  )
    throw new Error("Tag must be zh-vV or explicit zh-vV-rN");
  return explicit ?? base;
}
export function preflightSuite(suiteFile, currentSource) {
  const suite = readJson(suiteFile);
  if (suite.schema !== 1 || !Array.isArray(suite.artifacts) || suite.artifacts.length !== 4)
    throw new Error("Complete suite requires four artifacts");
  if (currentSource.dirty)
    throw new Error("Release requires clean source including untracked inputs");
  const base = NodePath.dirname(NodePath.resolve(suiteFile));
  const resolve = (file) => {
    if (typeof file !== "string" || !file) throw new Error("Missing asset/receipt path");
    return NodePath.resolve(base, file);
  };
  const kinds = new Set();
  const artifacts = [];
  for (const entry of suite.artifacts) {
    const artifact = resolve(entry.artifact);
    const candidate = readJson(resolve(entry.candidate));
    assertCandidate(candidate, artifact);
    if (kinds.has(candidate.kind)) throw new Error("Duplicate artifact kind");
    kinds.add(candidate.kind);
    if (candidate.version !== suite.version || !sameSource(candidate.source, currentSource))
      throw new Error("Mixed source/version; rebuild complete suite");
    const receiptFile = resolve(entry.receipt);
    const validation = verifyReceipt(
      candidate,
      receiptFile,
      entry.materials ? resolve(entry.materials) : undefined,
    );
    artifacts.push({
      candidate,
      file: artifact,
      validation,
      receiptSha256: fileIdentity(receiptFile).sha256,
      ...(entry.materials ? { materials: resolve(entry.materials) } : {}),
    });
  }
  for (const kind of ["dmg", "nsis", "linux", "windows"])
    if (!kinds.has(kind)) throw new Error(`Missing asset: ${kind}`);
  const linux = artifacts.find((a) => a.candidate.kind === "linux").candidate;
  const nsis = artifacts.find((a) => a.candidate.kind === "nsis").candidate;
  if (nsis.embeddedWslSha256 !== linux.sha256)
    throw new Error("Embedded WSL differs from suite Linux archive");
  const first = artifacts[0].candidate;
  if (artifacts.some((a) => a.candidate.upstreamCommit !== first.upstreamCommit))
    throw new Error("Mixed upstream identity");
  const provenance = {
    schema: 1,
    repository: REPO,
    version: suite.version,
    upstream: {
      repository: "pingdotgg/t3code",
      tag: first.upstreamTag,
      commit: first.upstreamCommit,
    },
    source: { commit: currentSource.head, treeSha256: currentSource.treeSha256 },
    artifacts: artifacts.map(({ candidate: c, validation }) => ({
      ...artifactSpec(c.version, c.kind),
      bytes: c.bytes,
      sha256: c.sha256,
      ...(c.embeddedWslSha256 ? { embeddedWslSha256: c.embeddedWslSha256 } : {}),
      structure: "passed",
      validation: validation.scope,
    })),
  };
  const publicJson = `${JSON.stringify(provenance, null, 2)}\n`;
  const checksums =
    [
      ...artifacts.map((a) => `${a.candidate.sha256}  ${a.candidate.name}`),
      `${sha256(publicJson)}  PROVENANCE.json`,
    ]
      .sort()
      .join("\n") + "\n";
  const assets = [
    ...artifacts.map((a) => ({
      name: a.candidate.name,
      bytes: a.candidate.bytes,
      sha256: a.candidate.sha256,
      file: a.file,
    })),
    {
      name: "PROVENANCE.json",
      bytes: Buffer.byteLength(publicJson),
      sha256: sha256(publicJson),
      text: publicJson,
    },
    {
      name: "SHA256SUMS",
      bytes: Buffer.byteLength(checksums),
      sha256: sha256(checksums),
      text: checksums,
    },
  ];
  const setSha256 = sha256(
    JSON.stringify(
      assets
        .map(({ name, bytes, sha256: hash }) => ({ name, bytes, sha256: hash }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
  );
  return { version: suite.version, source: currentSource, artifacts, assets, setSha256 };
}
export function checkRemoteState({ release, tagCommit, originHead }, prepared, tag) {
  if (originHead !== prepared.source.head)
    throw new Error("HEAD must equal origin/zh-i18n exactly");
  if (tagCommit !== undefined && tagCommit !== prepared.source.head)
    throw new Error("Tag points to another commit");
  if (!release) return;
  if (!release.draft)
    throw new Error("Published releases are immutable; choose an unused explicit -rN");
  const marker = `<!-- t3zh-source:${prepared.source.head}:${prepared.source.treeSha256} suite:${prepared.setSha256} -->`;
  if (
    release.tag_name !== tag ||
    release.target_commitish !== prepared.source.head ||
    !release.body?.includes(marker)
  )
    throw new Error("Draft source/suite identity mismatch");
  const expected = new Map(prepared.assets.map((a) => [a.name, a]));
  const seen = new Set();
  for (const asset of release.assets ?? []) {
    const local = expected.get(asset.name);
    if (
      seen.has(asset.name) ||
      !local ||
      asset.size !== local.bytes ||
      asset.digest !== `sha256:${local.sha256}` ||
      asset.state !== "uploaded"
    )
      throw new Error(`Draft conflicting/extra asset: ${asset.name}`);
    seen.add(asset.name);
  }
}
export function assertAllUploaded(release, prepared) {
  if (!release || release.assets?.length !== prepared.assets.length)
    throw new Error("Incomplete uploaded suite");
  for (const asset of prepared.assets) {
    const remote = release.assets.filter((a) => a.name === asset.name);
    if (
      remote.length !== 1 ||
      remote[0].size !== asset.bytes ||
      remote[0].digest !== `sha256:${asset.sha256}` ||
      remote[0].state !== "uploaded"
    )
      throw new Error(`Stored digest/size mismatch: ${asset.name}`);
  }
}
// 最终 NSIS 原件再次解出内层归档，与准备材料时的原件绑定。绝不从 win-unpacked 取代它。
export async function checkInstallerOriginal(prepared, sevenZip, scratch) {
  const nsis = prepared.artifacts.find((a) => a.candidate.kind === "nsis");
  const manifest = readJson(NodePath.join(nsis.materials, "materials.json"));
  const inner = NodePath.join(scratch, "app-64.7z");
  const fd = NodeFS.openSync(inner, "wx");
  try {
    NodeChildProcess.execFileSync(sevenZip, ["x", "-so", nsis.file, "$PLUGINSDIR/app-64.7z"], {
      stdio: ["ignore", fd, "pipe"],
    });
  } finally {
    NodeFS.closeSync(fd);
  }
  const actual = fileIdentity(inner);
  if (actual.sha256 !== manifest.inner?.sha256 || actual.bytes !== manifest.inner?.bytes)
    throw new Error("Final installer extraction identity mismatch");
  const payload = NodePath.join(scratch, "payload");
  // materials 的 member paths 已逐项受 checkFiles 检查；先核对原 listing 字节再解包。
  const listing = NodeChildProcess.execFileSync(sevenZip, ["l", "-slt", inner], {
    encoding: "utf8",
  });
  // 归档头的绝对路径不同，成员段必须一致。
  parse7zListing(listing);
  const previous = NodeFS.readFileSync(
    NodePath.join(nsis.materials, "payload-listing.txt"),
    "utf8",
  );
  if (listing.split(/\r?\n----------\r?\n/)[1] !== previous.split(/\r?\n----------\r?\n/)[1])
    throw new Error("Payload listing mismatch");
  NodeChildProcess.execFileSync(sevenZip, ["x", "-y", `-o${payload}`, inner], { stdio: "pipe" });
  checkFiles(
    payload,
    manifest.files
      .filter((r) => r.path.startsWith("payload-unpacked/"))
      .map((r) => ({ ...r, path: r.path.slice(17) })),
  );
  const asar = await import("@electron/asar");
  const serverAsar = NodePath.join(payload, "resources/server.asar");
  for (const member of asar.listPackage(serverAsar)) {
    if (asar.statFile(serverAsar, member.replace(/^[/\\]+/, ""), false).link)
      throw new Error("Extracted sidecar link refused");
  }
  const sidecar = NodePath.join(scratch, "sidecar");
  asar.extractAll(serverAsar, sidecar);
  const expected = manifest.files
    .filter((r) => r.path.startsWith("sidecar/"))
    .map((r) => ({ ...r, path: r.path.slice(8) }));
  checkFiles(sidecar, expected);
  if (
    inventory(sidecar).length !== expected.length ||
    inventory(payload).length !==
      manifest.files.filter((r) => r.path.startsWith("payload-unpacked/")).length
  )
    throw new Error("Extracted material file count mismatch");
}
export function ghEnvironment(base) {
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]) {
    if (base[name])
      throw new Error(
        `Unset ${name}; use gh-managed authentication without token environment variables`,
      );
  }
  return {
    ...base,
    HTTPS_PROXY: "http://127.0.0.1:2080",
    HTTP_PROXY: "http://127.0.0.1:2080",
    https_proxy: "http://127.0.0.1:2080",
    http_proxy: "http://127.0.0.1:2080",
  };
}
export async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      ...Object.fromEntries(
        ["suite", "tag", "seven-zip"].map((name) => [name, { type: "string" }]),
      ),
    },
  });
  if (!values.suite || !values["seven-zip"])
    throw new Error(
      "Usage: release-desktop-zh.mjs --suite suite.json --seven-zip /existing/7za [--dry-run] [--tag zh-vV-rN]",
    );
  const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
  ghEnvironment(process.env);
  const source = sourceIdentity(root);
  const prepared = preflightSuite(values.suite, source);
  const tag = releaseTag(prepared.version, values.tag);
  const version = git(root, "describe", "--tags", "--match", "v*-nightly.*", "--abbrev=0").replace(
    /^v/,
    "",
  );
  if (
    version !== prepared.version ||
    git(root, "rev-parse", `v${version}^{commit}`) !==
      prepared.artifacts[0].candidate.upstreamCommit
  )
    throw new Error("Current upstream baseline mismatch");
  if (
    !/^(?:git@github.com:|https:\/\/github.com\/|ssh:\/\/git@github.com\/)jieyuexing\/t3code-zh(?:\.git)?$/.test(
      git(root, "remote", "get-url", "origin"),
    )
  )
    throw new Error("Unexpected origin repository");
  if (!process.env.TMPDIR)
    throw new Error("Set task-owned TMPDIR/TMP/TEMP before release preflight");
  const scratch = NodeFS.mkdtempSync(NodePath.join(process.env.TMPDIR, "zh-release-"));
  await checkInstallerOriginal(prepared, values["seven-zip"], scratch);
  const merge = git(root, "log", "-1", "--merges", "--format=%H", "--grep=^merge", "HEAD");
  const body = merge ? git(root, "log", "-1", "--format=%B", merge) : "";
  const start = body.search(/^更新说明/m);
  if (start < 0) throw new Error("Latest sync merge lacks release notes");
  const notes = [
    `基于上游 v${version} 的简体中文版。`,
    "",
    "包含 macOS arm64 DMG、Windows x64 NSIS、Linux/Windows x64 CLI。产品版本和资产名沿用默认值。",
    "macOS 为 ad-hoc 签名，未公证。验证范围与 SHA-256 见 PROVENANCE.json / SHA256SUMS；不含安装、GUI、provider 或生产环境验收。",
    "",
    body
      .slice(start)
      .split(/^Co-Authored-By:/m)[0]
      .trim(),
    "",
    `<!-- t3zh-source:${source.head}:${source.treeSha256} suite:${prepared.setSha256} -->`,
    "",
  ].join("\n");
  // gh 自己持有凭据；令牌不进入 argv、env、临时文件或日志。
  const gh = (...args) =>
    NodeChildProcess.execFileSync("gh", args, {
      cwd: root,
      encoding: "utf8",
      env: ghEnvironment(process.env),
    }).trim();
  const findRelease = () => {
    const pages = JSON.parse(
      gh("api", `repos/${REPO}/releases?per_page=100`, "--paginate", "--slurp"),
    );
    const matches = pages.flat().filter((r) => r.tag_name === tag);
    if (matches.length > 1) throw new Error("Duplicate releases");
    return matches[0];
  };
  const remoteState = () => {
    const refs = git(
      root,
      "ls-remote",
      "origin",
      "refs/heads/zh-i18n",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    );
    const map = new Map(
      refs
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, ref] = line.split(/\s+/);
          return [ref, hash];
        }),
    );
    return {
      release: findRelease(),
      originHead: map.get("refs/heads/zh-i18n"),
      tagCommit: map.get(`refs/tags/${tag}^{}`) ?? map.get(`refs/tags/${tag}`),
    };
  };
  // gh uploads stall through the proxy (HTTP 408 on large assets), so assets go up with curl.
  // The token stays in memory and reaches curl only through a stdin config, never argv/env/files.
  const upload = (asset, release) => {
    const token = gh("auth", "token");
    const url = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
    const result = NodeChildProcess.spawnSync(
      "/usr/bin/curl",
      [
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--proxy",
        "http://127.0.0.1:2080",
        "--config",
        "-",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "Content-Type: application/octet-stream",
        "--data-binary",
        `@${asset.file}`,
        url,
      ],
      { input: `header = "Authorization: Bearer ${token}"\n`, encoding: "utf8", env: {} },
    );
    if (result.status !== 0)
      throw new Error(
        `Upload failed for ${asset.name}: ${(result.stderr || "").trim().slice(0, 300)}`,
      );
  };
  const assertUnchanged = () => {
    if (!sameSource(source, sourceIdentity(root)))
      throw new Error("Source changed during preflight");
    for (const a of prepared.artifacts) assertCandidate(a.candidate, a.file);
  };
  publishPrepared({
    prepared,
    tag,
    dryRun: values["dry-run"],
    remoteState,
    gh,
    upload,
    assertUnchanged,
    scratch,
    notes,
  });
}
export function publishPrepared({
  prepared,
  tag,
  dryRun,
  remoteState,
  gh,
  upload = (asset) => gh("release", "upload", tag, asset.file, "-R", REPO),
  assertUnchanged,
  scratch,
  notes,
  log = console.log,
}) {
  assertUnchanged();
  let state = remoteState();
  checkRemoteState(state, prepared, tag);
  if (dryRun) {
    assertUnchanged();
    log(
      `[zh-release] DRY RUN accepted ${tag}: six assets, complete same-source suite; no GitHub writes`,
    );
    return;
  }
  assertUnchanged();
  for (const asset of prepared.assets)
    if (asset.text !== undefined) {
      asset.file = NodePath.join(scratch, asset.name);
      NodeFS.writeFileSync(asset.file, asset.text, { flag: "wx" });
    }
  const notesFile = NodePath.join(scratch, "notes.md");
  NodeFS.writeFileSync(notesFile, notes, { flag: "wx" });
  if (!state.release) {
    gh(
      "release",
      "create",
      tag,
      "-R",
      REPO,
      "--draft",
      "--target",
      prepared.source.head,
      "--title",
      `T3 Code 中文版 ${prepared.version}`,
      "--notes-file",
      notesFile,
    );
    state = remoteState();
    if (!state.release)
      throw new Error("Draft creation accepted but draft not visible; inspect before retry");
    checkRemoteState(state, prepared, tag);
  }
  for (const asset of prepared.assets) {
    state = remoteState();
    checkRemoteState(state, prepared, tag);
    if (!state.release) throw new Error("Draft disappeared");
    if (!state.release.assets.some((a) => a.name === asset.name)) upload(asset, state.release);
    state = remoteState();
    checkRemoteState(state, prepared, tag);
    const uploaded = state.release?.assets.find((a) => a.name === asset.name);
    if (!uploaded || uploaded.digest !== `sha256:${asset.sha256}` || uploaded.size !== asset.bytes)
      throw new Error("Uploaded asset not yet verified; leave draft and inspect");
  }
  assertUnchanged();
  state = remoteState();
  checkRemoteState(state, prepared, tag);
  assertAllUploaded(state.release, prepared);
  gh("release", "edit", tag, "-R", REPO, "--draft=false", "--latest");
  state = remoteState();
  if (state.release?.draft !== false || state.tagCommit !== prepared.source.head)
    throw new Error("Publication response requires manual inspection");
  assertAllUploaded(state.release, prepared);
  log(`[zh-release] Published https://github.com/${REPO}/releases/tag/${tag}`);
}
if (import.meta.main) await main();
