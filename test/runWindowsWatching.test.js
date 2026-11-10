const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");

// Exercise the real watcher with Windows path semantics and real filesystem
// notifications, reproducing Electron's failure on namespace-prefixed paths.
test("native compiler paths validate without a reload loop and retain external file watching", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onda-windows-watch-"));
  fs.mkdirSync(path.join(root, "sources"));
  const local = path.join(root, "sources", "sample_player.onda");
  const reported = String.raw`\\?\C:\sources\sample_player.onda`;
  const regular = String.raw`C:\sources\sample_player.onda`;
  const text = "sample { out1 = 0.0 }\n";
  fs.writeFileSync(local, text);
  const reads = [];
  const diskPath = file => {
    reads.push(file);
    if (file.startsWith("\\\\?\\"))
      throw Object.assign(new Error("EISDIR: illegal operation on a directory, lstat 'C:'"), { code: "EISDIR" });
    return path.join(root, ...path.win32.relative("C:\\", file).split("\\"));
  };
  const disk = { ...fs,
    lstatSync: (file, ...args) => fs.lstatSync(diskPath(file), ...args),
    watch: (file, ...args) => fs.watch(diskPath(file), ...args),
    createReadStream: (file, ...args) => fs.createReadStream(diskPath(file), ...args),
    promises: { ...fs.promises, lstat: async (file, ...args) => fs.promises.lstat(diskPath(file), ...args) },
  };
  const load = (name, dependencies = {}) => {
    const context = { exports: {}, process: { platform: "win32" }, AbortController,
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
      require(name) {
        if (name === "path") return path.win32;
        if (name === "fs") return disk;
        return dependencies[name] ?? require(name);
      },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve(`../out/${name}.js`), "utf8"), context);
    return context.exports;
  };
  const dependencies = load("runDependencies");
  const { RunFileWatcher } = load("runFileWatcher", { "./runDependencies": dependencies });
  let reloads = 0;
  const watcher = new RunFileWatcher(() => reloads++);
  try {
    watcher.update([regular, reported]);
    await watcher.validate({ [reported]: createHash("sha256").update(text).digest("hex") });
    await delay(200);
    assert.equal(reloads, 0, "successful compilation must stay running after fingerprint validation");
    assert.ok(watcher.isCurrent(regular));
    assert.ok(watcher.isCurrent(reported));
    assert.ok(reads.every(file => !file.startsWith("\\\\?\\")));
    fs.writeFileSync(local, "sample { out1 = 0.25 }\n");
    const deadline = Date.now() + 5000;
    while (reloads === 0 && Date.now() < deadline) await delay(10);
    assert.equal(reloads, 1, "a real content edit still reloads automatically");
  } finally {
    watcher.dispose();
    fs.rmSync(root, { recursive:true, force:true });
  }
});
