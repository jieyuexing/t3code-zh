/* eslint-disable t3code/no-global-process-runtime -- Standalone target probe must not resolve host dependencies. */
// W4 R2 的有界探针：仅加载原生模块，PTY 退出后释放探针自身资源。
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const root = fs.realpathSync(process.argv[2]);
const mode = process.argv[3];
const req = createRequire(path.join(root, "apps/server/dist/bin.mjs"));
const inside = (p) => {
  const real = fs.realpathSync(p);
  const rel = path.relative(root, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
    throw Error("External resolution: " + p);
  return real;
};
const emit = (obj) =>
  console.log(JSON.stringify({ utc: new Date().toISOString(), pid: process.pid, ...obj }));
(async () => {
  if (process.platform !== "win32" || process.arch !== "x64") throw Error("Expected Windows x64");
  if (mode === "node") {
    emit({
      mode,
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      nodePath: process.env.NODE_PATH,
      globalPaths: require("node:module").globalPaths,
      monitorEnabled: process.env.T3CODE_RESOURCE_MONITOR_ENABLED,
    });
    return;
  }
  const pkg = {
    ffi: "ffi-rs",
    fff: "@ff-labs/fff-node",
    keyring: "@napi-rs/keyring",
    pty: "node-pty",
  }[mode];
  const resolved = inside(req.resolve(pkg));
  emit({ mode, package: pkg, resolved });
  const mod = mode === "fff" ? await import(pathToFileURL(resolved).href) : req(pkg);
  if (mode === "fff") {
    const binary = inside(mod.findBinary());
    const ffi = req("ffi-rs");
    ffi.open({ library: "t3zh_probe_fff", path: binary });
    ffi.close("t3zh_probe_fff");
    emit({ mode, loaded: true, binary, operation: "library open/close only; no finder creation" });
  } else if (mode === "pty") {
    const utils = req("node-pty/lib/utils.js");
    utils.loadNativeModule("conpty");
    emit({ mode, nativeLoaded: true });
    const term = mod.spawn(
      path.join(process.env.SystemRoot, "System32/cmd.exe"),
      ["/d", "/c", "echo T3ZH-PTY-OK"],
      { cwd: process.cwd(), env: { ...process.env }, cols: 80, rows: 24 },
    );
    let output = "",
      captured = 0;
    const capture = () => {
      if (term.pid > 0 && !captured) {
        captured = term.pid;
        emit({ mode, event: "pty-spawn", childPid: captured, deadlineSeconds: 20 });
      }
    };
    const poll = setInterval(capture, 10);
    capture();
    const deadline = setTimeout(() => {
      capture();
      emit({ mode, event: "timeout", childPid: captured });
      if (captured)
        try {
          process.kill(captured);
        } catch {}
      process.exitCode = 2;
    }, 18000);
    term.onData((data) => {
      capture();
      output += data;
    });
    term.onExit((event) => {
      capture();
      clearInterval(poll);
      clearTimeout(deadline);
      emit({
        mode,
        event: "pty-exit",
        childPid: captured,
        exitCode: event.exitCode,
        output,
        ok: output.includes("T3ZH-PTY-OK") && event.exitCode === 0,
      });
      process.exitCode = output.includes("T3ZH-PTY-OK") && event.exitCode === 0 ? 0 : 1;
      term._agent._conoutSocketWorker.dispose();
      term._agent.inSocket.destroy();
      emit({
        mode,
        event: "probe-cleanup",
        operation: "dispose owned conout worker and input socket after observed child exit",
      });
    });
  } else
    emit({
      mode,
      loaded: true,
      operation: mode === "keyring" ? "module load only; no credential calls" : "module load",
    });
  for (const filename of Object.keys(require.cache).filter((p) => p.endsWith(".node")))
    emit({ mode, nativeLoadedPath: inside(filename) });
})().catch((error) => {
  emit({ mode, error: String(error), stack: error.stack });
  process.exitCode = 1;
});
