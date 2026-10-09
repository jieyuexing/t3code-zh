import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import {
  preflightSuite,
  publishPrepared,
  ghEnvironment,
  checkRemoteState,
  assertAllUploaded,
  releaseTag,
} from "./release-desktop-zh.mjs";
import { fileIdentity, artifactSpec, sourceIdentity } from "./release-source-zh.mjs";
import { verifyReceipt, parse7zListing } from "./release-validation-zh.mjs";

const version = "0.0.46-nightly.20261008.2833";
const source = { head: "1".repeat(40), treeSha256: "2".repeat(64), dirty: false };
const write = (file, value) => NodeFS.writeFileSync(file, JSON.stringify(value));
function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-fixture-"));
  const entries = [];
  const candidates = {};
  const receipts = {};
  const stageRefs = {};
  const identity = (path) => ({ path, ...fileIdentity(NodePath.join(root, path)) });
  function stage(kind, name, stdout, stderr = "", exitCode = 0) {
    const key = `${kind}-${name}`;
    NodeFS.writeFileSync(NodePath.join(root, `${key}.stdout`), stdout);
    NodeFS.writeFileSync(NodePath.join(root, `${key}.stderr`), stderr);
    const value = {
      stage: name,
      exitCode,
      timedOut: false,
      error: null,
      deadlineSeconds: 20,
      startedUtc: "2026-10-09T00:00:00Z",
      finishedUtc: "2026-10-09T00:00:00Z",
      stdout: identity(`${key}.stdout`),
      stderr: identity(`${key}.stderr`),
    };
    write(NodePath.join(root, `${key}.json`), value);
    stageRefs[key] = value;
    return identity(`${key}.json`);
  }
  for (const kind of ["linux", "windows", "dmg", "nsis"]) {
    const spec = artifactSpec(version, kind);
    const artifact = NodePath.join(root, spec.name);
    NodeFS.writeFileSync(artifact, `fixture-${kind}`);
    const candidate = {
      schema: 1,
      kind,
      version,
      ...spec,
      ...fileIdentity(artifact),
      source,
      upstreamTag: `v${version}`,
      upstreamCommit: "3".repeat(40),
      structure: "passed",
      native: "pending",
      ...(kind === "nsis" ? { embeddedWslSha256: candidates.linux.sha256 } : {}),
    };
    candidates[kind] = candidate;
    const receipt = {
      schema: 1,
      kind,
      version,
      platform: spec.platform,
      arch: spec.arch,
      source,
      artifactSha256: candidate.sha256,
      stages: {},
    };
    if (kind === "nsis") {
      const materials = NodePath.join(root, "materials");
      NodeFS.mkdirSync(materials);
      const files = ["windows-native-probe-zh.cjs", "validate-windows-zh.ps1"].map((name) => {
        NodeFS.copyFileSync(new URL(name, import.meta.url), NodePath.join(materials, name));
        return { path: name, ...fileIdentity(NodePath.join(materials, name)) };
      });
      write(NodePath.join(materials, "materials.json"), {
        schema: 1,
        candidate,
        embeddedWslSha256: candidate.embeddedWslSha256,
        files,
      });
      receipt.materialsSha256 = fileIdentity(NodePath.join(materials, "materials.json")).sha256;
      receipt.integrityBefore = receipt.integrityAfter = receipt.materialsSha256;
      receipt.isolation = {
        environmentCleared: true,
        noGlobalSearchPaths: true,
        nodePath: "",
        monitorEnabled: false,
        ancestors: [{ nodeModules: false, reparse: false }],
      };
      receipt.removedDependency = "ffi-rs";
      receipt.removedFiles = 5;
      const event = (value) => JSON.stringify(value) + "\n";
      receipt.stages.electron = stage(kind, "electron", "v24.21.0\n");
      receipt.stages.node = stage(
        kind,
        "node",
        event({
          platform: "win32",
          arch: "x64",
          nodePath: "",
          globalPaths: [],
          monitorEnabled: "false",
          versions: { node: "24.21.0", electron: "44.4.2" },
        }),
      );
      receipt.stages.bad = stage(kind, "bad", "", "ERR_MODULE_NOT_FOUND: ffi-rs", 1);
      receipt.stages.good = stage(kind, "good", `t3 v${version}\n`);
      for (const name of ["ffi", "fff", "keyring"])
        receipt.stages[name] = stage(kind, name, event({ mode: name, loaded: true }));
      receipt.stages.pty = stage(
        kind,
        "pty",
        [
          { nativeLoaded: true },
          { event: "pty-exit", exitCode: 0, ok: true, output: "T3ZH-PTY-OK" },
          { event: "probe-cleanup" },
        ]
          .map(event)
          .join(""),
      );
    } else if (kind === "dmg") {
      receipt.stages.attach = stage(kind, "attach", "<key>mount-point</key>");
      receipt.stages.architecture = stage(kind, "architecture", "arm64");
      receipt.stages.plist = stage(kind, "plist", version);
      receipt.stages.detach = stage(kind, "detach", "disk ejected");
      receipt.stages.signature = stage(
        kind,
        "signature",
        "",
        "fixture: satisfies its Designated Requirement",
      );
      receipt.stages.content = stage(
        kind,
        "content",
        JSON.stringify({
          version,
          arch: "arm64",
          feedFree: true,
          chineseBundle: true,
          readOnlyMount: true,
          sourceHead: source.head,
          asarSha256: "4".repeat(64),
        }),
      );
    } else {
      receipt.monitorEnabled = false;
      receipt.stages.version = stage(kind, "version", `t3 v${version}\n`);
      receipt.stages.smoke = stage(
        kind,
        "smoke",
        `t3-${version}-${spec.platform}-x64: --version passed and serve answered on 47700.`,
      );
    }
    if (["linux", "windows"].includes(kind)) {
      Object.assign(stageRefs[`${kind}-smoke`], {
        monitorEnabled: false,
        environmentCleared: true,
        artifactSha256: candidate.sha256,
        server: { httpStatus: 200, termination: { code: null, signal: "SIGTERM" } },
      });
      write(NodePath.join(root, `${kind}-smoke.json`), stageRefs[`${kind}-smoke`]);
      receipt.stages.smoke = identity(`${kind}-smoke.json`);
    }
    receipts[kind] = receipt;
    write(NodePath.join(root, `${kind}.candidate.json`), candidate);
    write(NodePath.join(root, `${kind}.receipt.json`), receipt);
    entries.push({
      artifact: spec.name,
      candidate: `${kind}.candidate.json`,
      receipt: `${kind}.receipt.json`,
      ...(kind === "nsis" ? { materials: "materials" } : {}),
    });
  }
  const suite = { schema: 1, version, artifacts: entries };
  const suiteFile = NodePath.join(root, "suite.json");
  write(suiteFile, suite);
  return {
    root,
    suite,
    suiteFile,
    candidates,
    receipts,
    stageRefs,
    identity,
    close: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}
function withFixture(fn) {
  const f = fixture();
  try {
    fn(f);
  } finally {
    f.close();
  }
}

// 先拒绝真实不合格输入，再接受完整 fixture；fixture 不是 Windows 实测。
for (const [name, mutate] of [
  [
    "missing asset",
    (f) => {
      f.suite.artifacts.pop();
      write(f.suiteFile, f.suite);
    },
  ],
  [
    "wrong hash",
    (f) => NodeFS.appendFileSync(NodePath.join(f.root, f.candidates.dmg.name), "changed"),
  ],
  [
    "mixed dirty source",
    (f) => {
      f.candidates.dmg.source = { ...source, treeSha256: "5".repeat(64), dirty: true };
      write(NodePath.join(f.root, "dmg.candidate.json"), f.candidates.dmg);
    },
  ],
  ["missing receipt", (f) => NodeFS.unlinkSync(NodePath.join(f.root, "nsis.receipt.json"))],
  [
    "wrong OS",
    (f) => {
      f.receipts.nsis.platform = "linux";
      write(NodePath.join(f.root, "nsis.receipt.json"), f.receipts.nsis);
    },
  ],
  [
    "wrong arch",
    (f) => {
      f.receipts.nsis.arch = "arm64";
      write(NodePath.join(f.root, "nsis.receipt.json"), f.receipts.nsis);
    },
  ],
  [
    "wrong version",
    (f) => {
      f.receipts.nsis.version = "0.0.45";
      write(NodePath.join(f.root, "nsis.receipt.json"), f.receipts.nsis);
    },
  ],
  [
    "native failure",
    (f) => {
      f.stageRefs["nsis-ffi"].exitCode = 1;
      write(NodePath.join(f.root, "nsis-ffi.json"), f.stageRefs["nsis-ffi"]);
      f.receipts.nsis.stages.ffi = f.identity("nsis-ffi.json");
      write(NodePath.join(f.root, "nsis.receipt.json"), f.receipts.nsis);
    },
  ],
  [
    "native timeout",
    (f) => {
      f.stageRefs["nsis-pty"].timedOut = true;
      write(NodePath.join(f.root, "nsis-pty.json"), f.stageRefs["nsis-pty"]);
      f.receipts.nsis.stages.pty = f.identity("nsis-pty.json");
      write(NodePath.join(f.root, "nsis.receipt.json"), f.receipts.nsis);
    },
  ],
  [
    "forged passed flag",
    (f) => write(NodePath.join(f.root, "nsis.receipt.json"), { passed: true }),
  ],
  [
    "tampered log",
    (f) => NodeFS.appendFileSync(NodePath.join(f.root, "nsis-good.stdout"), "tamper"),
  ],
  [
    "ancestor contamination",
    (f) => {
      f.receipts.nsis.isolation.ancestors[0].nodeModules = true;
      write(NodePath.join(f.root, "nsis.receipt.json"), f.receipts.nsis);
    },
  ],
])
  NodeTest.test(`rejects ${name}`, () =>
    withFixture((f) => {
      mutate(f);
      NodeAssert.throws(() => preflightSuite(f.suiteFile, source));
    }),
  );

NodeTest.test(
  "complete local fixture yields exactly six public assets without private receipts",
  () =>
    withFixture((f) => {
      const prepared = preflightSuite(f.suiteFile, source);
      NodeAssert.equal(prepared.assets.length, 6);
      const provenance = prepared.assets.find((a) => a.name === "PROVENANCE.json").text;
      NodeAssert.ok(!provenance.includes(f.root));
      NodeAssert.ok(
        !/pid|ancestors|materialsSha256|receiptSha256|stdout|USERPROFILE/.test(provenance),
      );
      NodeAssert.match(
        prepared.assets.find((a) => a.name === "SHA256SUMS").text,
        /PROVENANCE.json/,
      );
      NodeAssert.throws(() => preflightSuite(f.suiteFile, { ...source, dirty: true }), /clean/);
    }),
);

NodeTest.test("draft state rejects wrong branch/tag/source/assets and published releases", () =>
  withFixture((f) => {
    const p = preflightSuite(f.suiteFile, source),
      tag = releaseTag(version);
    const release = {
      draft: true,
      tag_name: tag,
      target_commitish: source.head,
      body: `<!-- t3zh-source:${source.head}:${source.treeSha256} suite:${p.setSha256} -->`,
      assets: [],
    };
    const state = { originHead: source.head, release };
    NodeAssert.throws(
      () => checkRemoteState({ ...state, originHead: "another-remote-contains-head" }, p, tag),
      /origin\/zh-i18n/,
    );
    NodeAssert.throws(
      () => checkRemoteState({ ...state, tagCommit: "0".repeat(40) }, p, tag),
      /Tag/,
    );
    for (const change of [
      { body: "old source" },
      { draft: false },
      { target_commitish: "zh-i18n" },
      { assets: [{ name: "extra", size: 1, digest: "sha256:x" }] },
    ])
      NodeAssert.throws(() =>
        checkRemoteState({ ...state, release: { ...release, ...change } }, p, tag),
      );
    NodeAssert.throws(() => assertAllUploaded(release, p), /Incomplete/);
    checkRemoteState(state, p, tag);
    release.assets = p.assets.map((a) => ({
      name: a.name,
      size: a.bytes,
      digest: `sha256:${a.sha256}`,
      state: "uploaded",
    }));
    checkRemoteState(state, p, tag);
    assertAllUploaded(release, p);
    release.assets[0].digest = "sha256:wrong";
    NodeAssert.throws(() => checkRemoteState(state, p, tag), /conflicting/);
    NodeAssert.throws(() => assertAllUploaded(release, p), /digest/);
  }),
);

NodeTest.test("revision tag is explicit and preserves product version", () => {
  NodeAssert.throws(() => releaseTag(version, `zh-v${version}-r0`));
  NodeAssert.throws(() => releaseTag(version, "other"));
  NodeAssert.equal(releaseTag(version), `zh-v${version}`);
  NodeAssert.equal(releaseTag(version, `zh-v${version}-r1`), `zh-v${version}-r1`);
});
NodeTest.test("7z listing rejects traversal, duplicate and links before extraction", () => {
  for (const data of [
    "Path = ../bad",
    "Path = good\nSymbolic Link = /outside",
    "Path = good\n\nPath = GOOD",
  ])
    NodeAssert.throws(() => parse7zListing(`header\n----------\n${data}\n`));
  NodeAssert.equal(
    parse7zListing("header\n----------\nPath = resources/server.asar\nSize = 2\n").length,
    1,
  );
});
NodeTest.test(
  "source identity changes for untracked build inputs and scripts, with HEAD unchanged",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "source-fixture-"));
    try {
      for (const dir of ["apps/server", "apps/web", "apps/desktop"])
        NodeFS.mkdirSync(NodePath.join(root, dir), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, "build.mjs"), "// original\n");
      const git = (...args) =>
        NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init");
      git("add", ".");
      git(
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
      const before = sourceIdentity(root);
      NodeFS.writeFileSync(NodePath.join(root, "new-helper.mjs"), "// new\n");
      const after = sourceIdentity(root);
      NodeAssert.equal(before.head, after.head);
      NodeAssert.notEqual(before.treeSha256, after.treeSha256);
      NodeAssert.equal(after.dirty, true);
      NodeFS.appendFileSync(NodePath.join(root, "new-helper.mjs"), "// changed\n");
      NodeAssert.notEqual(sourceIdentity(root).treeSha256, after.treeSha256);
    } finally {
      NodeFS.rmSync(root, { recursive: true });
    }
  },
);
NodeTest.test(
  "legacy W4 summary without bound source/materials/stage originals cannot issue release approval",
  () =>
    withFixture((f) => {
      const file = NodePath.join(f.root, "legacy.json");
      write(file, {
        status: "bounded-windows-payload-validation-passed",
        installerSha256: f.candidates.nsis.sha256,
        passed: true,
      });
      NodeAssert.throws(
        () => verifyReceipt(f.candidates.nsis, file, NodePath.join(f.root, "materials")),
        /identity/,
      );
    }),
);

NodeTest.test(
  "dry-run and conflicting draft perform zero writes; matching draft resumes and only publishes complete digests",
  () =>
    withFixture((f) => {
      const prepared = preflightSuite(f.suiteFile, source),
        tag = releaseTag(version);
      const marker = `<!-- t3zh-source:${source.head}:${source.treeSha256} suite:${prepared.setSha256} -->`;
      let release;
      let tagCommit;
      const writes = [];
      const remoteState = () => ({ originHead: source.head, tagCommit, release });
      const gh = (...args) => {
        writes.push(args);
        if (args[1] === "create")
          release = {
            draft: true,
            tag_name: tag,
            target_commitish: source.head,
            body: marker,
            assets: [],
          };
        if (args[1] === "upload") {
          const asset = prepared.assets.find((a) => a.file === args[3]);
          release.assets.push({
            name: asset.name,
            size: asset.bytes,
            digest: `sha256:${asset.sha256}`,
            state: "uploaded",
          });
        }
        if (args[1] === "edit") {
          NodeAssert.equal(release.assets.length, 6);
          release.draft = false;
          tagCommit = source.head;
        }
      };
      const options = {
        log: () => {},
        prepared,
        tag,
        remoteState,
        gh,
        assertUnchanged: () => {},
        scratch: f.root,
        notes: "Fixture notes",
      };
      publishPrepared({ ...options, dryRun: true });
      NodeAssert.equal(writes.length, 0);
      release = {
        draft: true,
        tag_name: tag,
        target_commitish: source.head,
        body: "wrong source",
        assets: [],
      };
      NodeAssert.throws(() => publishPrepared({ ...options, dryRun: true }), /Draft source/);
      NodeAssert.equal(writes.length, 0);
      release = {
        draft: true,
        tag_name: tag,
        target_commitish: source.head,
        body: marker,
        assets: [
          {
            name: prepared.assets[0].name,
            size: prepared.assets[0].bytes,
            digest: `sha256:${prepared.assets[0].sha256}`,
            state: "uploaded",
          },
        ],
      };
      publishPrepared({ ...options, dryRun: false });
      NodeAssert.equal(writes.filter((a) => a[1] === "create").length, 0);
      NodeAssert.equal(writes.filter((a) => a[1] === "upload").length, 5);
      NodeAssert.equal(writes.at(-1)[1], "edit");
    }),
);
NodeTest.test("upload with stored hash mismatch never reaches publication", () =>
  withFixture((f) => {
    const prepared = preflightSuite(f.suiteFile, source),
      tag = releaseTag(version);
    let release;
    const writes = [];
    const gh = (...args) => {
      writes.push(args);
      if (args[1] === "create")
        release = {
          draft: true,
          tag_name: tag,
          target_commitish: source.head,
          body: `<!-- t3zh-source:${source.head}:${source.treeSha256} suite:${prepared.setSha256} -->`,
          assets: [],
        };
      if (args[1] === "upload")
        release.assets.push({
          name: prepared.assets[0].name,
          size: prepared.assets[0].bytes,
          digest: "sha256:wrong",
          state: "uploaded",
        });
    };
    NodeAssert.throws(
      () =>
        publishPrepared({
          log: () => {},
          prepared,
          tag,
          dryRun: false,
          remoteState: () => ({ originHead: source.head, release }),
          gh,
          assertUnchanged: () => {},
          scratch: f.root,
          notes: "Fixture notes",
        }),
      /conflicting/,
    );
    NodeAssert.ok(!writes.some((a) => a[1] === "edit"));
  }),
);

NodeTest.test(
  "publisher only uses gh-managed credentials and rejects token-bearing environment",
  () => {
    NodeAssert.throws(() => ghEnvironment({ GH_TOKEN: "fixture-token" }), /gh-managed/);
    NodeAssert.throws(
      () => ghEnvironment({ GITHUB_ENTERPRISE_TOKEN: "fixture-token" }),
      /gh-managed/,
    );
    const env = ghEnvironment({ PATH: "/fixture/bin" });
    NodeAssert.equal(env.HTTPS_PROXY, "http://127.0.0.1:2080");
    NodeAssert.ok(!("GH_TOKEN" in env));
  },
);
