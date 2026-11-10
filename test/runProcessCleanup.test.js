const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRunPanel } = require("./helpers/runPanel");

for (const mode of ["playback", "metadata"]) {
  test(`Stop kills ${mode} descendants after their launcher and its pipes close`, {
    skip: process.platform === "win32", timeout: 20000,
  }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "onda-process-tree-")));
    const source = path.join(root, "main.onda");
    fs.writeFileSync(source, "sample:\n  out1 = 0.0\n");
    const server = net.createServer();
    let descendantSocket;
    const ready = new Promise(resolve => server.once("connection", socket => {
      descendantSocket = socket;
      socket.once("data", () => resolve());
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let launcher;
    const panel = createRunPanel("0.9.0", {
      settings: {
        "compiler.source": "external", "exec.path": process.execPath,
        "exec.args": [path.join(__dirname, "fixtures", "processTree.js"), String(server.address().port)],
      },
      modules: { child_process: { ...childProcess, spawn(...args) {
        launcher = childProcess.spawn(...args);
        return launcher;
      } } },
    });
    t.after(async () => {
      // Also clean up the process group when testing the unfixed implementation.
      if (launcher?.pid) {
        try { process.kill(-launcher.pid, "SIGKILL"); } catch {}
      }
      descendantSocket?.destroy();
      server.close();
      await panel.evaluate("stopFile({silent:true});disposeRunFileWatcher()");
      fs.rmSync(root, { recursive: true, force: true });
    });
    panel.context.source = source;
    let refreshing;
    if (mode === "playback") await panel.evaluate("runFile(source)");
    else refreshing = panel.evaluate("refreshStoppedRunMetadata(source)");
    await ready;
    const exited = once(launcher, "exit");
    const launcherClosed = once(launcher, "close");
    const closed = once(descendantSocket, "close", { signal: AbortSignal.timeout(5000) });
    await panel.evaluate("stopFile({silent:true})");
    await refreshing;
    assert.equal((await exited)[1], "SIGTERM", "The launcher must exit before escalation");
    await launcherClosed;
    await assert.doesNotReject(closed, "The descendant must exit even after its launcher closes stdio");
  });
}
