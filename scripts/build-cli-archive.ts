#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- Synchronous build-input integrity checks need Git/tar output and exact file bytes before extraction.
/**
 * Packages the server single-executable into a self-contained per-platform
 * archive: the `t3` binary, the web client, the resource monitor, and a
 * production install of the native packages the bundle keeps external. The
 * archive is the unit every runtime installer downloads, so nothing in it may
 * require Node, npm, or a compiler on the machine that unpacks it.
 *
 * Layout inside the archive (a single top-level directory named after the
 * archive stem):
 *
 *   t3 | t3.exe          the single-executable
 *   client/              web app served by the server
 *   resource-monitor/    per-platform Rust helper, same paths as the npm package
 *   node_modules/        runtime externals (node-pty, msgpackr-extract, fff)
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
  STAGE_INSTALL_ARGS,
} from "./build-desktop-artifact.ts";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64"]);
type BuildPlatform = typeof BuildPlatform.Type;
type BuildArch = typeof BuildArch.Type;

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

export class CliArchiveCommandFailedError extends Schema.TaggedError<CliArchiveCommandFailedError>()(
  "CliArchiveCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export class CliArchiveInputMissingError extends Schema.TaggedError<CliArchiveInputMissingError>()(
  "CliArchiveInputMissingError",
  { inputPath: Schema.String, hint: Schema.String },
) {
  override get message(): string {
    return `Missing ${this.inputPath}. ${this.hint}`;
  }
}

/** Platform/arch pair as it appears in archive names and `process.platform`/`process.arch`. */
export function cliArchivePlatformKey(platform: BuildPlatform, arch: BuildArch): string {
  const nodePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return `${nodePlatform}-${arch}`;
}

export function cliArchiveStem(version: string, platform: BuildPlatform, arch: BuildArch): string {
  return `t3-${version}-${cliArchivePlatformKey(platform, arch)}`;
}

export function cliArchiveFileName(version: string, platform: BuildPlatform, arch: BuildArch) {
  // gzip rather than xz: GNU tar needs an external xz binary for -J, which
  // minimal hosts lack, while every tar (and Node's zlib) handles gzip alone.
  return `${cliArchiveStem(version, platform, arch)}.${platform === "win" ? "zip" : "tar.gz"}`;
}

/** The bsdtar Windows ships in System32; resolves regardless of which tar is first on PATH. */
export function windowsSystemTar(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Output is inherited so the build log shows what each tool did; a failing
  // signing or packaging step is otherwise a bare exit code.
  const child = yield* spawner.spawn(
    ChildProcess.isStandardCommand(command)
      ? ChildProcess.make(command.command, command.args, {
          ...command.options,
          stdout: "inherit",
          stderr: "inherit",
        })
      : command,
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new CliArchiveCommandFailedError({ command: label, exitCode });
  }
});

const requireInput = Effect.fn("requireInput")(function* (inputPath: string, hint: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(inputPath))) {
    return yield* new CliArchiveInputMissingError({ inputPath, hint });
  }
});

/**
 * Installs the runtime-external packages into `stageDir/node_modules` with a
 * hoisted, symlink-free layout. The tree is archived and unpacked on machines
 * without pnpm, so the store layout cannot be relied on to survive the trip.
 */
const stageRuntimeExternals = Effect.fn("stageRuntimeExternals")(function* (input: {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* decodeWorkspaceConfig(
    yield* fs.readFileString(path.join(input.repoRoot, "pnpm-workspace.yaml")),
  );
  const catalog = workspace.catalog ?? {};
  const serverDependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies,
    catalog,
    "apps/server",
  );
  const fffNodeVersion = serverDependencies["@ff-labs/fff-node"];
  if (fffNodeVersion === undefined) {
    return yield* new CliArchiveInputMissingError({
      inputPath: "apps/server/package.json#dependencies['@ff-labs/fff-node']",
      hint: "The archive stages fff's platform binary from this version.",
    });
  }
  const dependencies = {
    ...selectCliRuntimeExternalDependencies(serverDependencies),
    ...resolveFffNativeDependencies(input.platform, input.arch, fffNodeVersion),
  };
  const patchedDependencies = createStagePatchedDependencies(
    workspace.patchedDependencies ?? {},
    dependencies,
  );

  yield* fs.writeFileString(
    path.join(input.stageDir, "package.json"),
    `${yield* encodeJsonString({
      name: "t3-runtime",
      version: input.version,
      private: true,
      packageManager: rootPackageJson.packageManager,
      dependencies,
    })}\n`,
  );
  yield* fs.writeFileString(
    path.join(input.stageDir, "pnpm-workspace.yaml"),
    yield* encodeStageWorkspaceConfig({
      ...createStageWorkspaceConfig({
        platform: input.platform,
        arch: input.arch,
        ...(workspace.allowBuilds ? { allowBuilds: workspace.allowBuilds } : {}),
        patchedDependencies,
        overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/server"),
      }),
      nodeLinker: "hoisted",
    }),
  );
  if (Object.keys(patchedDependencies).length > 0) {
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(input.stageDir, "patches"));
  }

  const install = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(install.command, install.args, {
      cwd: input.stageDir,
      shell: install.shell,
      stdout: "inherit",
      stderr: "inherit",
    }),
    "vp install --prod (cli archive runtime externals)",
  );

  // pnpm's bookkeeping and the manifest only matter to pnpm; the runtime
  // resolves packages by directory. node-pty ships every platform's prebuilds
  // in one package (58 MB); only the archive's own platform loads.
  const platformKey = cliArchivePlatformKey(input.platform, input.arch);
  const prebuildsDir = path.join(input.stageDir, "node_modules/node-pty/prebuilds");
  const foreignPrebuilds = (yield* fs
    .readDirectory(prebuildsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter(
    (entry) => entry !== platformKey,
  );
  for (const entry of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "patches",
    "node_modules/.pnpm",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.bin",
    ...foreignPrebuilds.map((entry) => `node_modules/node-pty/prebuilds/${entry}`),
  ]) {
    yield* fs.remove(path.join(input.stageDir, entry), { recursive: true, force: true });
  }
  // A hoisted install still leaves nested `node_modules/.bin` shim directories
  // inside packages that declare bins (msgpackr-extract's). They are symlinks
  // nothing runs, and the npm registry refuses a tarball that contains any
  // symlink, so strip every `.bin` directory below node_modules.
  yield* removeNestedBinDirectories(fs, path, path.join(input.stageDir, "node_modules"));
});

const removeNestedBinDirectories = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const child = path.join(root, entry);
      if (entry === ".bin") {
        yield* fs.remove(child, { recursive: true, force: true });
        continue;
      }
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") {
        yield* removeNestedBinDirectories(fs, path, child);
      }
    }
  });

/** Copies the web client without its sourcemaps, which nothing serves. */
const stageWebClient = Effect.fn("stageWebClient")(function* (source: string, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.copy(source, target);
  const maps = (yield* fs.readDirectory(target, { recursive: true })).filter((entry) =>
    entry.endsWith(".map"),
  );
  for (const entry of maps) {
    yield* fs.remove(path.join(target, entry), { force: true });
  }
});

const MacSigningConfig = Config.all({
  identity: Config.String("T3CODE_CLI_MAC_SIGN_IDENTITY").pipe(Config.option),
  appleApiKey: Config.String("APPLE_API_KEY").pipe(Config.option),
  appleApiKeyId: Config.String("APPLE_API_KEY_ID").pipe(Config.option),
  appleApiIssuer: Config.String("APPLE_API_ISSUER").pipe(Config.option),
});

/**
 * Apple Silicon refuses to run unsigned Mach-O binaries at all, so the
 * executable is always signed: ad hoc when no identity is configured, or with
 * the Developer ID plus notarization when it is. The hardened runtime that
 * notarization requires only loads signed libraries, so every native addon in
 * the archive is signed with the same identity.
 */
const signMacArchiveContents = Effect.fn("signMacArchiveContents")(function* (input: {
  readonly repoRoot: string;
  readonly contentDir: string;
  readonly executablePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const signing = yield* MacSigningConfig;
  const identity = Option.getOrUndefined(signing.identity)?.trim() || "-";

  const entitlements = path.join(input.repoRoot, "apps/server/resources/cli-entitlements.plist");
  const libraries = (yield* fs.readDirectory(input.contentDir, { recursive: true }))
    .filter(
      (entry) =>
        entry.endsWith(".node") ||
        entry.endsWith(".dylib") ||
        entry.endsWith("spawn-helper") ||
        entry.endsWith("t3-resource-monitor"),
    )
    .map((entry) => path.join(input.contentDir, entry));

  for (const target of [...libraries, input.executablePath]) {
    yield* runCommand(
      ChildProcess.make("codesign", [
        "--force",
        "--sign",
        identity,
        ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
        ...(target === input.executablePath ? ["--entitlements", entitlements] : []),
        target,
      ]),
      `codesign ${path.relative(input.contentDir, target)}`,
    );
  }
  if (identity === "-") {
    yield* Effect.log("[cli-archive] Signed ad hoc (no T3CODE_CLI_MAC_SIGN_IDENTITY).");
    return;
  }

  const apiKey = Option.getOrUndefined(signing.appleApiKey);
  const apiKeyId = Option.getOrUndefined(signing.appleApiKeyId);
  const apiIssuer = Option.getOrUndefined(signing.appleApiIssuer);
  if (!apiKey || !apiKeyId || !apiIssuer) {
    yield* Effect.logWarning(
      "[cli-archive] Developer ID signed but not notarized (missing APPLE_API_KEY*).",
    );
    return;
  }
  // notarytool only accepts archives, and a bare executable cannot be stapled,
  // so notarize a zip of the binary and rely on the online ticket lookup.
  const notarizeZip = path.join(path.dirname(input.executablePath), ".notarize-t3.zip");
  yield* runCommand(
    ChildProcess.make("ditto", ["-c", "-k", "--keepParent", input.executablePath, notarizeZip]),
    "ditto (notarization zip)",
  );
  yield* runCommand(
    ChildProcess.make("xcrun", [
      "notarytool",
      "submit",
      notarizeZip,
      "--key",
      apiKey,
      "--key-id",
      apiKeyId,
      "--issuer",
      apiIssuer,
      "--wait",
    ]),
    "notarytool submit",
  ).pipe(Effect.ensuring(fs.remove(notarizeZip, { force: true }).pipe(Effect.ignore)));
  yield* Effect.log("[cli-archive] Notarized t3.");
});

const WindowsSigningConfig = Config.all({
  endpoint: Config.String("AZURE_TRUSTED_SIGNING_ENDPOINT").pipe(Config.option),
  accountName: Config.String("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME").pipe(Config.option),
  certificateProfileName: Config.String("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME").pipe(
    Config.option,
  ),
});

/**
 * Node's --build-sea injects the blob into a copy of node.exe by rebuilding
 * its resource section but, unlike its Mach-O path, leaves node's original
 * Authenticode data-directory entry in the PE header. The file grows, so the
 * entry now points into the middle of the new section at bytes that are not a
 * certificate table. signtool refuses to sign such an image (0x800700C1, "not
 * a valid Win32 application") and cannot `remove /s` it either, since the SIP
 * fails to parse the garbage. Clearing the entry is exactly what a signature
 * strip does, without needing a parser that trusts the broken table.
 */
const stripStaleAuthenticodeEntry = Effect.fn("stripStaleAuthenticodeEntry")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(executablePath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (view.getUint32(peOffset, true) !== 0x00004550) {
    return yield* new CliArchiveInputMissingError({
      inputPath: executablePath,
      hint: "Expected a PE executable to strip the stale signature entry from.",
    });
  }
  const optionalHeader = peOffset + 24;
  const magic = view.getUint16(optionalHeader, true);
  // Data directories start at +112 (PE32+) or +96 (PE32); the certificate
  // table is directory index 4, eight bytes (file offset, size).
  const securityEntry = optionalHeader + (magic === 0x20b ? 112 : 96) + 4 * 8;
  const offset = view.getUint32(securityEntry, true);
  const size = view.getUint32(securityEntry + 4, true);
  if (offset === 0 && size === 0) return;
  if (offset + size === bytes.byteLength) {
    // A certificate table that still ends at EOF is intact; leave it for
    // signtool to replace rather than second-guessing it here.
    return;
  }
  view.setUint32(securityEntry, 0, true);
  view.setUint32(securityEntry + 4, 0, true);
  yield* fs.writeFile(executablePath, bytes);
  yield* Effect.log(
    `[cli-archive] Cleared the stale Authenticode entry (offset ${String(offset)}, size ${String(size)}) left by --build-sea.`,
  );
});

/** Signs t3.exe through the same Azure Trusted Signing setup the installer uses. */
const signWindowsExecutable = Effect.fn("signWindowsExecutable")(function* (
  executablePath: string,
) {
  const signing = yield* WindowsSigningConfig;
  const endpoint = Option.getOrUndefined(signing.endpoint);
  const accountName = Option.getOrUndefined(signing.accountName);
  const profile = Option.getOrUndefined(signing.certificateProfileName);
  if (!endpoint || !accountName || !profile) {
    yield* Effect.log("[cli-archive] Windows signing disabled (missing Azure Trusted Signing).");
    return;
  }
  yield* stripStaleAuthenticodeEntry(executablePath);
  // Mirrors electron-builder's invocation for the installer: every value
  // single-quoted, the file path in Windows form. `$ErrorActionPreference`
  // makes a signing failure inside the cmdlet surface as a non-zero exit.
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "Invoke-TrustedSigning",
    `-Endpoint ${quote(endpoint)}`,
    `-CodeSigningAccountName ${quote(accountName)}`,
    `-CertificateProfileName ${quote(profile)}`,
    "-FileDigest 'SHA256'",
    "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
    "-TimestampDigest 'SHA256'",
    `-Files ${quote(executablePath)}`,
  ].join(" ");
  yield* runCommand(
    ChildProcess.make("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script]),
    "Invoke-TrustedSigning t3.exe",
  );
  yield* Effect.log("[cli-archive] Signed t3.exe (Azure Trusted Signing).");
});

// 仅在依赖、补丁和 native 源码完全相同的 nightly 上复用官方闭包。
const officialBaselinePaths = [
  "native/resource-monitor",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
  "scripts/lib/cli-external-packages.ts",
];
const OfficialRelease = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      digest: Schema.String,
      browser_download_url: Schema.String,
    }),
  ),
});
const decodeOfficialRelease = Schema.decodeUnknownSync(OfficialRelease);
const hashFile = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const toolOutput = (command: string, args: string[], cwd?: string) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

export function validateTemplateMembers(names: string[], verbose: string[], stem: string) {
  if (!names.length || names.length !== verbose.length) throw new Error("Archive listing mismatch");
  const seen = new Set<string>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const clean = name.replace(/\/$/, "");
    // 官方归档没有链接；全部拒绝链接/设备，且拒绝 tar 输出会转义的文件名。
    if (
      !/^[-d]/.test(verbose[i]!) ||
      !/^[A-Za-z0-9_$@+.,/()= -]+$/.test(name) ||
      name.includes(" ") ||
      clean.split("/").some((part) => !part || part === "." || part === "..") ||
      !(clean === stem || clean.startsWith(`${stem}/`)) ||
      seen.has(clean)
    ) {
      throw new Error(`Unsafe archive member: ${name}`);
    }
    seen.add(clean);
  }
  for (const member of [
    "node_modules",
    "resource-monitor",
    "client",
    stem.endsWith("win32-x64") ? "t3.exe" : "t3",
  ]) {
    if (!seen.has(`${stem}/${member}`)) throw new Error(`Missing archive member: ${member}`);
  }
}

export function assertX64Binary(
  file: string,
  platform: "linux" | "win",
  arch: "x64" | "arm64" | "ia32" = "x64",
) {
  const bytes = NodeFS.readFileSync(file);
  if (platform === "linux") {
    if (
      bytes.toString("hex", 0, 4) !== "7f454c46" ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== 62
    ) {
      throw new Error(`Expected Linux x64 ELF: ${file}`);
    }
  } else {
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
    if (
      bytes.toString("ascii", 0, 2) !== "MZ" ||
      offset + 6 > bytes.length ||
      bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 4) !== { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c }[arch]
    ) {
      throw new Error(`Expected Windows x64 PE: ${file}`);
    }
  }
}

export function verifyOfficialTemplate(input: {
  repoRoot: string;
  hostPlatform: NodeJS.Platform;
  archive: string;
  metadata: string;
  sums: string;
  version: string;
  platform: BuildPlatform;
  arch: BuildArch;
}) {
  if (input.arch !== "x64" || input.platform === "mac")
    throw new Error("Template reuse only supports linux/win x64");
  const tag = `v${input.version}`;
  if (!/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)) throw new Error("Expected nightly tag");
  const git = (...args: string[]) => toolOutput("git", args, input.repoRoot).trim();
  git("merge-base", "--is-ancestor", tag, "HEAD");
  if (git("diff", tag, "--", ...officialBaselinePaths))
    throw new Error("Official native/dependency baseline mismatch");
  const original = JSON.parse(git("show", `${tag}:apps/server/package.json`));
  const current = JSON.parse(
    NodeFS.readFileSync(NodePath.join(input.repoRoot, "apps/server/package.json"), "utf8"),
  );
  if (JSON.stringify({ ...current, version: original.version }) !== JSON.stringify(original))
    throw new Error("Server dependency baseline mismatch");
  const release = decodeOfficialRelease(JSON.parse(NodeFS.readFileSync(input.metadata, "utf8")));
  const releaseUrl = `https://github.com/pingdotgg/t3code/releases/tag/${tag}`;
  if (release.tag_name !== tag || release.html_url !== releaseUrl)
    throw new Error("Official release identity mismatch");
  const name = cliArchiveFileName(input.version, input.platform, input.arch);
  if (NodePath.basename(input.archive) !== name)
    throw new Error("Official archive basename mismatch");
  const verify = (assetName: string, file: string) => {
    const matches = release.assets.filter((asset) => asset.name === assetName);
    const asset = matches[0];
    const hash = hashFile(file);
    if (
      matches.length !== 1 ||
      !asset ||
      asset.browser_download_url !==
        `https://github.com/pingdotgg/t3code/releases/download/${tag}/${assetName}` ||
      asset.size !== NodeFS.statSync(file).size ||
      asset.digest !== `sha256:${hash}`
    )
      throw new Error(`Official asset hash/size/URL mismatch: ${assetName}`);
    return hash;
  };
  const archiveHash = verify(name, input.archive);
  const sumsHash = verify("SHA256SUMS", input.sums);
  const sums = NodeFS.readFileSync(input.sums, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.endsWith(`  ${name}`));
  if (sums.length !== 1 || sums[0] !== `${archiveHash}  ${name}`)
    throw new Error("SHA256SUMS mismatch");
  const tar = input.hostPlatform === "win32" ? windowsSystemTar() : "tar";
  const listing = (flag: string) => toolOutput(tar, [flag, input.archive]).trimEnd().split(/\r?\n/);
  validateTemplateMembers(
    listing("-tf"),
    listing("-tvf"),
    cliArchiveStem(input.version, input.platform, input.arch),
  );
  return {
    tag,
    upstreamCommit: git("rev-parse", `${tag}^{commit}`),
    releaseUrl,
    archiveHash,
    sumsHash,
    baselineTrees: git("ls-tree", tag, ...officialBaselinePaths).split("\n"),
  };
}

const stageOfficialTemplate = Effect.fn("stageOfficialTemplate")(function* (input: {
  repoRoot: string;
  hostPlatform: NodeJS.Platform;
  archive: string;
  metadata: string;
  sums: string;
  version: string;
  platform: BuildPlatform;
  arch: BuildArch;
  stageRoot: string;
  contentDir: string;
}) {
  const provenance = yield* Effect.sync(() => verifyOfficialTemplate(input));
  const stem = cliArchiveStem(input.version, input.platform, input.arch);
  yield* runCommand(
    ChildProcess.make(input.hostPlatform === "win32" ? windowsSystemTar() : "tar", [
      "-xf",
      input.archive,
      "-C",
      input.stageRoot,
      `${stem}/node_modules`,
      `${stem}/resource-monitor`,
    ]),
    "extract verified official native closure",
  );
  const reused: { path: string; bytes: number; sha256: string }[] = [];
  const walk = (relative: string) => {
    const absolute = NodePath.join(input.contentDir, relative);
    const stat = NodeFS.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of NodeFS.readdirSync(absolute).sort()) walk(`${relative}/${entry}`);
    } else if (stat.isFile()) {
      if (/\.(node|dll|exe|so)$/.test(relative) || relative.endsWith("/t3-resource-monitor")) {
        // node-pty 的源包保留其他 Windows 架构的 vendor 工具，ffi-rs 同时带 ia32 sibling。
        // 这些不供 x64 loader 使用，但也按目录声明校验其真实 PE 架构，完整记录原字节。
        const vendor = relative.includes("/third_party/conpty/");
        const arch =
          vendor && relative.includes("/win10-arm64/")
            ? "arm64"
            : relative.includes("/@yuuang/ffi-rs-win32-ia32-msvc/")
              ? "ia32"
              : "x64";
        assertX64Binary(absolute, vendor ? "win" : (input.platform as "linux" | "win"), arch);
      }
      reused.push({ path: relative, bytes: stat.size, sha256: hashFile(absolute) });
    } else throw new Error(`Unexpected extracted file type: ${relative}`);
  };
  yield* Effect.sync(() => {
    walk("node_modules");
    walk("resource-monitor");
  });
  return { ...provenance, reused };
});

const buildCliArchive = Effect.fn("buildCliArchive")(function* (input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly version: string;
  readonly outputDir: string;
  readonly resourceMonitorDir: Option.Option<string>;
  readonly officialArchive: Option.Option<string>;
  readonly releaseMetadata: Option.Option<string>;
  readonly sha256sums: Option.Option<string>;
  readonly verifyTemplateOnly: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const hostPlatform = yield* HostProcessPlatform;
  const officialArchive = Option.getOrUndefined(input.officialArchive);
  const metadata = Option.getOrUndefined(input.releaseMetadata);
  const sums = Option.getOrUndefined(input.sha256sums);
  if (
    (officialArchive || metadata || sums || input.verifyTemplateOnly) &&
    !(officialArchive && metadata && sums)
  ) {
    return yield* Effect.die(
      new Error("Template reuse requires --official-archive, --release-metadata and --sha256sums"),
    );
  }
  const template =
    officialArchive && metadata && sums
      ? {
          repoRoot,
          hostPlatform,
          archive: path.resolve(officialArchive),
          metadata: path.resolve(metadata),
          sums: path.resolve(sums),
          version: input.version,
          platform: input.platform,
          arch: input.arch,
        }
      : undefined;
  if (template) {
    yield* Effect.sync(() => verifyOfficialTemplate(template));
    if (input.verifyTemplateOnly) {
      yield* Effect.log("Official template verified.");
      return;
    }
  }
  const serverDir = path.join(repoRoot, "apps/server");
  const executableName = input.platform === "win" ? "t3.exe" : "t3";
  // tsdown suffixes cross-built executables with their target (t3-darwin-x64);
  // a host build is plain t3. Prefer the exact target when both exist.
  const targetKey = `${input.platform === "mac" ? "darwin" : input.platform}-${input.arch}`;
  const targetExecutable = path.join(
    serverDir,
    "dist-exe",
    `t3-${targetKey}${input.platform === "win" ? ".exe" : ""}`,
  );
  // The unsuffixed host build is only a valid stand-in when it was built for
  // this platform and architecture; otherwise a missing target must fail.
  const hostKey = `${hostPlatform === "win32" ? "win" : hostPlatform}-${yield* HostProcessArchitecture}`;
  const builtExecutable = (yield* fs.exists(targetExecutable))
    ? targetExecutable
    : targetKey === hostKey
      ? path.join(serverDir, "dist-exe", executableName)
      : targetExecutable;
  const webClient = path.join(serverDir, "dist/client");
  const resourceMonitorDir = Option.getOrElse(input.resourceMonitorDir, () =>
    path.join(serverDir, "dist/resource-monitor"),
  );

  yield* requireInput(
    builtExecutable,
    `Run \`node apps/server/scripts/cli.ts build-exe --target ${targetKey}\` first.`,
  );
  yield* requireInput(path.join(webClient, "index.html"), "Run `vp run --filter t3 build` first.");
  if (!template)
    yield* requireInput(
      resourceMonitorDir,
      "Build the resource monitor or pass --resource-monitor-dir.",
    );

  const stem = cliArchiveStem(input.version, input.platform, input.arch);
  const stageRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-archive-" });
  const contentDir = path.join(stageRoot, stem);
  yield* fs.makeDirectory(contentDir, { recursive: true });

  yield* Effect.log(`[cli-archive] Staging ${stem}...`);
  yield* fs.copyFile(builtExecutable, path.join(contentDir, executableName));
  yield* stageWebClient(webClient, path.join(contentDir, "client"));
  const provenance = template
    ? yield* stageOfficialTemplate({ ...template, stageRoot, contentDir })
    : undefined;
  if (!template) {
    yield* fs.copy(resourceMonitorDir, path.join(contentDir, "resource-monitor"));
    yield* stageRuntimeExternals({
      repoRoot,
      stageDir: contentDir,
      platform: input.platform,
      arch: input.arch,
      version: input.version,
    });
  }
  if (template)
    yield* Effect.sync(() =>
      assertX64Binary(path.join(contentDir, executableName), input.platform as "linux" | "win"),
    );
  const executablePath = path.join(contentDir, executableName);
  if (input.platform === "mac") {
    yield* signMacArchiveContents({ repoRoot, contentDir, executablePath });
  } else if (input.platform === "win") {
    yield* signWindowsExecutable(executablePath);
  }
  if (input.platform !== "win") {
    yield* fs.chmod(executablePath, 0o755);
  }

  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const archivePath = path.join(
    input.outputDir,
    cliArchiveFileName(input.version, input.platform, input.arch),
  );
  yield* fs.remove(archivePath, { force: true });
  if (input.platform === "win") {
    // Windows ships bsdtar, which writes zip natively. Name it by path: under
    // the Git Bash shell CI uses, a bare `tar` is GNU tar, which neither
    // writes zip nor accepts a drive-letter path.
    yield* runCommand(
      ChildProcess.make(hostPlatform === "win32" ? windowsSystemTar() : "tar", [
        "-a",
        "-c",
        "-f",
        archivePath,
        "-C",
        stageRoot,
        stem,
      ]),
      "tar (zip)",
    );
  } else {
    // On Linux, pnpm hard-links identical files out of its store and node-gyp
    // hard-links build outputs, and GNU tar records those as link entries.
    // The npm registry rejects a tarball containing any, and the npm platform
    // packages are re-packed from this archive's contents, so store every
    // file as a file. macOS's bsdtar has no such flag; pnpm clones there.
    yield* runCommand(
      ChildProcess.make("tar", [
        ...(hostPlatform === "linux" ? ["--hard-dereference"] : []),
        "-czf",
        archivePath,
        "-C",
        stageRoot,
        stem,
      ]),
      "tar (gzip)",
    );
  }
  if (provenance) {
    const receipt = yield* Effect.sync(() => ({
      ...provenance,
      candidateSha256: hashFile(archivePath),
      forkExecutableSha256: hashFile(builtExecutable),
      forkHead: toolOutput("git", ["rev-parse", "HEAD"], repoRoot).trim(),
      forkDiffSha256: NodeCrypto.createHash("sha256")
        .update(toolOutput("git", ["diff", "HEAD", "--binary"], repoRoot))
        .digest("hex"),
    }));
    yield* fs.writeFileString(
      `${archivePath}.provenance.json`,
      `${yield* encodeJsonString(receipt)}\n`,
    );
  }
  const stat = yield* fs.stat(archivePath);
  yield* Effect.log(`[cli-archive] Wrote ${archivePath} (${String(stat.size)} bytes).`);
  return archivePath;
});

const command = Command.make(
  "build-cli-archive",
  {
    platform: Flag.Literals("platform", BuildPlatform.literals),
    arch: Flag.Literals("arch", BuildArch.literals),
    version: Flag.String("version").pipe(
      Flag.withDescription("Release version for the archive name."),
    ),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault("release-cli")),
    officialArchive: Flag.String("official-archive").pipe(Flag.optional),
    releaseMetadata: Flag.String("release-metadata").pipe(Flag.optional),
    sha256sums: Flag.String("sha256sums").pipe(Flag.optional),
    verifyTemplateOnly: Flag.Boolean("verify-template-only").pipe(Flag.withDefault(false)),
    resourceMonitorDir: Flag.String("resource-monitor-dir").pipe(
      Flag.withDescription(
        "Directory laid out like dist/resource-monitor (defaults to apps/server/dist/resource-monitor).",
      ),
      Flag.optional,
    ),
  },
  (input) => buildCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Package the t3 single-executable into a per-platform archive."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
