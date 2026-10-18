const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { RunFileWatcher } = require("../out/runFileWatcher");
const { createLifecyclePanel } = require("./helpers/runLifecycle");

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "filesystem change was not observed");
    await delay(10);
  }
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "onda-vscode-watch-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, "main.onda");
  const voice = path.join(root, "voice.onda");
  fs.writeFileSync(entry, "import voice\n");
  fs.writeFileSync(voice, "const value = 1.0\n");
  return { root, entry, voice };
}

function contentHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("native watches share directories and do no idle polling", async t => {
  const { root, entry, voice } = fixture(t);
  const watch = fs.watch;
  const watchedDirectories = [];
  t.mock.method(fs, "watch", (...args) => {
    watchedDirectories.push(args[0]);
    return watch(...args);
  });
  const polling = t.mock.method(fs, "watchFile");
  const stats = t.mock.method(fs, "statSync");
  const lstats = t.mock.method(fs, "lstatSync");
  const watcher = new RunFileWatcher(() => {});
  t.after(() => watcher.dispose());
  watcher.update([entry, voice]);
  assert.equal(polling.mock.callCount(), 0);
  assert.equal(watchedDirectories.filter(directory => directory === root).length, 1);
  const initialStats = stats.mock.callCount();
  const initialLstats = lstats.mock.callCount();
  await delay(600);
  assert.equal(stats.mock.callCount(), initialStats);
  assert.equal(lstats.mock.callCount(), initialLstats);
});

test("directory watches survive repeated atomic saves and ancestor replacement", async t => {
  const { root } = fixture(t);
  const parent = path.join(root, "nested");
  const directory = path.join(parent, "code");
  const entry = path.join(directory, "main.onda");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(entry, "original\n");
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([entry]);
  for (let i = 1; i <= 2; i++) {
    const replacement = path.join(directory, "replacement.tmp");
    fs.writeFileSync(replacement, `replacement ${i}\n`);
    fs.renameSync(replacement, entry);
    await waitFor(() => changes === i);
  }
  fs.renameSync(parent, path.join(root, "old"));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(entry, "new directory\n");
  await waitFor(() => changes === 3);
  fs.writeFileSync(entry, "later edit\n");
  await waitFor(() => changes === 4);
});

for (const failure of ["open", "error"]) {
  test(`watch ${failure} failures poll only affected files every second and recover`, async t => {
    const { root } = fixture(t);
    const failedDirectory = path.join(root, "failed");
    const healthyDirectory = path.join(root, "healthy");
    fs.mkdirSync(failedDirectory);
    fs.mkdirSync(healthyDirectory);
    const failedFile = path.join(failedDirectory, "main.onda");
    const healthyFile = path.join(healthyDirectory, "main.onda");
    for (const file of [failedFile, healthyFile]) fs.writeFileSync(file, "original\n");
    const watch = fs.watch;
    const lstat = fs.lstatSync;
    let unavailable = failure === "open";
    let failedWatch;
    let recovered = false;
    let healthyChecks = 0;
    t.mock.method(fs, "watch", (directory, ...args) => {
      if (directory === failedDirectory && unavailable) throw new Error("watch unavailable");
      const watcher = watch(directory, ...args);
      if (directory === failedDirectory) {
        recovered = failedWatch !== undefined || failure === "open";
        failedWatch = watcher;
      }
      return watcher;
    });
    const intervals = t.mock.method(global, "setInterval");
    t.mock.method(fs, "lstatSync", (file, ...args) => {
      if (file === healthyFile) healthyChecks++;
      return lstat(file, ...args);
    });
    let changes = 0;
    const watcher = new RunFileWatcher(() => changes++);
    t.after(() => watcher.dispose());
    watcher.update([failedFile, healthyFile]);
    if (failure === "error") {
      unavailable = true;
      failedWatch.emit("error", new Error("watch lost"));
      await delay(30);
    }
    assert.equal(intervals.mock.callCount(), 1);
    assert.equal(intervals.mock.calls[0].arguments[1], 1000);
    const initialHealthyChecks = healthyChecks;
    fs.writeFileSync(failedFile, "changed while unwatched\n");
    await waitFor(() => changes === 1);
    assert.equal(healthyChecks, initialHealthyChecks);
    unavailable = false;
    await waitFor(() => recovered);
    const idleHealthyChecks = healthyChecks;
    const idleChecks = t.mock.method(fs, "lstatSync");
    await delay(1150);
    assert.equal(idleChecks.mock.callCount(), 0);
    assert.equal(healthyChecks, idleHealthyChecks);
    fs.writeFileSync(failedFile, "changed after native recovery\n");
    await waitFor(() => changes === 2);
  });
}

test("missing directory watches advance as each parent is created", async t => {
  const { root } = fixture(t);
  const first = path.join(root, "new");
  const second = path.join(first, "nested");
  const entry = path.join(second, "main.onda");
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([entry]);
  fs.mkdirSync(first);
  await delay(150);
  fs.mkdirSync(second);
  await delay(150);
  assert.equal(changes, 0);
  fs.writeFileSync(entry, "created\n");
  await waitFor(() => changes === 1);
  fs.writeFileSync(entry, "edited\n");
  await waitFor(() => changes === 2);
});

test("replacing an ancestor with a symlink invalidates and repairs the source", {
  skip: process.platform === "win32",
}, async t => {
  const { root } = fixture(t);
  const directory = path.join(root, "code");
  const moved = path.join(root, "moved");
  const entry = path.join(directory, "main.onda");
  fs.mkdirSync(directory);
  fs.writeFileSync(entry, "original\n");
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([entry]);
  fs.renameSync(directory, moved);
  fs.symlinkSync(moved, directory);
  await waitFor(() => changes === 1);
  assert.equal(watcher.isCurrent(entry), false);
  fs.unlinkSync(directory);
  fs.renameSync(moved, directory);
  await waitFor(() => changes === 2);
  fs.writeFileSync(entry, "edited after repair\n");
  await waitFor(() => changes === 3);
});

test("discovery fingerprints detect imports added before watcher registration", async t => {
  const { root, entry, voice } = fixture(t);
  const panel = await startPanel(t, entry);
  const contentHashes = { [entry]: contentHash(entry), [voice]: contentHash(voice) };
  const child = path.join(root, "child.onda");
  fs.writeFileSync(child, "const child_gain = 9.0\n");
  fs.writeFileSync(voice, "import child\n");
  panel.context.graph = { files: [entry, voice], complete: true, contentHashes };
  panel.evaluate("updateRunDependencies(input, graph)");
  await waitFor(() => panel.launches.length === 2);
  panel.sources([entry, voice, child]);
  fs.writeFileSync(child, "const child_gain = 11.0\n");
  await waitFor(() => panel.launches.length === 3);
});

test("compiled fingerprints detect transient content reverted before registration", async t => {
  const { voice } = fixture(t);
  const compiledHash = createHash("sha256").update("const value = 9.0\n").digest("hex");
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([voice]);
  await watcher.validate({ [voice]: compiledHash });
  await waitFor(() => changes === 1);
});

test("a missing dependency created before registration invalidates discovery", async t => {
  const { root } = fixture(t);
  const child = path.join(root, "child.onda");
  fs.writeFileSync(child, "const child_gain = 9.0\n");
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([child]);
  await watcher.validate({ [child]: null });
  await waitFor(() => changes === 1);
});

test("matching hashes and superseded validations do not restart a newer run", async t => {
  const { entry, voice } = fixture(t);
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([entry, voice]);
  const staleHash = createHash("sha256").update("old").digest("hex");
  const stale = watcher.validate({ [voice]: staleHash });
  watcher.acknowledge();
  const current = watcher.validate({ [voice]: contentHash(voice) });
  await Promise.all([stale, current]);
  await delay(400);
  assert.equal(changes, 0);
});

test("stopped metadata installs the actual compiled dependency graph", async t => {
  const { root, entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  await panel.evaluate("stopFile({ silent: true })");
  const child = path.join(root, "child.onda");
  fs.writeFileSync(child, "const child_gain = 9.0\n");
  panel.setDaemonMetadataGraph({ files: [entry, voice, child], complete: true });
  await panel.evaluate("refreshStoppedRunMetadata(input)");
  const before = panel.daemonRequests.length;
  fs.writeFileSync(child, "const child_gain = 11.0\n");
  await waitFor(() => panel.daemonRequests.length > before);
  assert.equal(panel.state().processingRequested, false);
});

test("failed metadata validates transient compiler reads and retries while stopped", async t => {
  const { entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  await panel.evaluate("stopFile({ silent: true })");
  panel.setDaemonError("transient compile failure");
  panel.setDaemonMetadataGraph({
    files: [entry, voice], complete: false,
    contentHashes: { [voice]: createHash("sha256").update("invalid transient source").digest("hex") },
  });
  await panel.evaluate("refreshStoppedRunMetadata(input)");
  const before = panel.daemonRequests.length;
  panel.setDaemonError(undefined);
  panel.setDaemonMetadataGraph({
    files: [entry, voice], complete: true, contentHashes: { [voice]: contentHash(voice) },
  });
  await waitFor(() => panel.daemonRequests.length > before);
  assert.equal(panel.state().processingRequested, false);
  assert.equal(panel.state().error, null);
});

test("failed playback source events validate transient compiler reads and restart", async t => {
  const { entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  panel.launches[0].child.stdout.emit("data", Buffer.from(JSON.stringify({
    event: "sources", files: [entry, voice], complete: false,
    contentHashes: { [voice]: createHash("sha256").update("invalid transient source").digest("hex") },
  }) + "\n"));
  panel.launches[0].child.emit("exit", 1, null);
  await waitFor(() => panel.launches.length === 2);
  assert.equal(panel.state().processingRequested, true);
  assert.equal(panel.state().error, null);
});

test("ready notifications install the actual playback dependency graph", async t => {
  const { root, entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  const child = path.join(root, "child.onda");
  fs.writeFileSync(child, "const child_gain = 9.0\n");
  panel.launches[0].child.stdout.emit("data", Buffer.from(JSON.stringify({
    event: "ready", sources: { files: [entry, voice, child], complete: true },
  }) + "\n"));
  fs.writeFileSync(child, "const child_gain = 11.0\n");
  await waitFor(() => panel.launches.length === 2);
});

async function startPanel(t, input, files = [input]) {
  const panel = createLifecyclePanel();
  t.after(() => panel.evaluate("disposeRunFileWatcher()"));
  panel.context.input = input;
  await panel.evaluate("runFile(input, { fastMath: true })");
  panel.sources(files);
  panel.setDaemonGraph({ files, complete: true });
  return panel;
}

test("external dependency edits reload without saving dirty editors or moving focus", async t => {
  const { root, entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  panel.evaluate(`
    let inputSaves = 0;
    const dirtyInput = { uri: vscode.Uri.file(input), isDirty: true,
      async save() { inputSaves++; this.isDirty = false; return true; } };
    vscode.workspace.textDocuments.push(dirtyInput);
  `);
  fs.writeFileSync(path.join(root, "unrelated.onda"), "const value = 2.0\n");
  fs.writeFileSync(voice, "const value = 3.0\n");
  await waitFor(() => panel.launches.length === 2);
  assert.ok(panel.launches[1].args.includes(entry));
  assert.ok(panel.launches[1].args.includes("--fast-math"));
  assert.equal(panel.panelReveals.at(-1).preserveFocus, true);
  assert.equal(panel.evaluate("inputSaves"), 0);
  assert.equal(panel.evaluate("dirtyInput.isDirty"), true);
  await delay(650);
  assert.equal(panel.launches.length, 2);
});

test("missing nested imports recover on creation, deletion, and recreation", async t => {
  const { root, entry } = fixture(t);
  const missing = path.join(root, "nested", "modules", "missing.onda");
  const panel = await startPanel(t, entry);
  panel.sources([entry, missing], false);
  panel.launches[0].child.emit("exit", 1, null);
  fs.mkdirSync(path.dirname(missing), { recursive: true });
  fs.writeFileSync(missing, "const value = 1.0\n");
  await waitFor(() => panel.launches.length === 2);
  assert.equal(panel.state().error, null);
  panel.sources([entry, missing]);

  fs.rmSync(path.join(root, "nested"), { recursive: true });
  await waitFor(() => panel.launches.length === 3);
  panel.sources([entry, missing], false);
  panel.launches[2].child.emit("exit", 1, null);
  fs.mkdirSync(path.dirname(missing), { recursive: true });
  fs.writeFileSync(missing, "const value = 2.0\n");
  await waitFor(() => panel.launches.length === 4);
  assert.ok(panel.launches[3].args.includes(entry));
  assert.equal(panel.state().processingRequested, true);
});

test("external project, entry, and buffer asset replacements reload the selected project", async t => {
  const { root, entry } = fixture(t);
  const manifest = path.join(root, "project.ondaproject");
  const assets = [path.join(root, "clip.wav"), path.join(root, "clip.ondabuffer")];
  fs.writeFileSync(manifest, '{"entry":"main.onda"}');
  for (const asset of assets) fs.writeFileSync(asset, "original asset");
  const files = [manifest, entry, ...assets];
  const panel = await startPanel(t, manifest, files);
  for (const [index, file] of files.entries()) {
    const replacement = path.join(root, "replacement.tmp");
    fs.writeFileSync(replacement, `replacement ${index}`);
    fs.renameSync(replacement, file);
    await waitFor(() => panel.launches.length === index + 2);
    assert.ok(panel.launches.at(-1).args.includes(manifest));
    panel.sources(files);
  }
});

test("external edits while stopped refresh metadata without resuming audio", async t => {
  const { entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  await panel.evaluate("stopFile({ silent: true })");
  fs.writeFileSync(voice, "const value = 2.0\n");
  await waitFor(() => panel.state().params[0]?.name === "updated");
  assert.equal(panel.launches.filter(({ args }) => args.includes("play")).length, 1);
  assert.equal(panel.state().running, false);
  assert.equal(panel.state().processingRequested, false);
  assert.equal(panel.state().error, null);
});

test("disk and editor-save notifications reload once in either delivery order", async t => {
  const { entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  fs.writeFileSync(voice, "const value = 2.0\n");
  await panel.savePath(voice);
  assert.equal(panel.launches.length, 2);
  panel.sources([entry, voice]);
  await delay(650);
  assert.equal(panel.launches.length, 2);

  fs.writeFileSync(voice, "const value = 3.0\n");
  await waitFor(() => panel.launches.length === 3);
  panel.sources([entry, voice]);
  await panel.savePath(voice);
  await delay(650);
  assert.equal(panel.launches.length, 3);
});

for (const newInput of [false, true]) {
  for (const notification of ["disk", "editor save"]) {
    test(`${notification} notifications cannot cancel a Run waiting for its save: new input ${newInput}`, async t => {
      const { root, entry, voice } = fixture(t);
      const panel = await startPanel(t, entry, [entry, voice]);
      const selected = newInput ? path.join(root, "next.onda") : entry;
      if (newInput) fs.writeFileSync(selected, "const value = 1.0\n");
      panel.context.selected = selected;
      panel.evaluate(`
        let finishSave;
        vscode.workspace.textDocuments.push({
          uri: vscode.Uri.file(selected), isDirty: true,
          save() { return new Promise(resolve => {
            finishSave = () => { this.isDirty = false; resolve(true); };
          }); },
        });
      `);
      const starting = panel.evaluate("runFile(selected)");
      fs.writeFileSync(voice, "const value = 2.0\n");
      if (notification === "editor save") await panel.savePath(voice);
      await delay(650);
      assert.equal(panel.launches.length, 1);
      panel.evaluate("finishSave()");
      await starting;
      assert.equal(panel.launches.length, 2);
      assert.ok(panel.launches[1].args.includes(selected));
      assert.equal(panel.launches[1].args.includes("--fast-math"), false);
      await delay(650);
      assert.equal(panel.launches.length, 2);
    });
  }
}

test("a dependency save still reloads when the pending Run save is cancelled", async t => {
  const { root, entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  panel.context.selected = path.join(root, "next.onda");
  fs.writeFileSync(panel.context.selected, "const value = 1.0\n");
  panel.evaluate(`
    vscode.window.showErrorMessage = () => {};
    let finishSave;
    vscode.workspace.textDocuments.push({
      uri: vscode.Uri.file(selected), isDirty: true,
      save() { return new Promise(resolve => { finishSave = () => resolve(false); }); },
    });
  `);
  const starting = panel.evaluate("runFile(selected)");
  fs.writeFileSync(voice, "const value = 2.0\n");
  await panel.savePath(voice);
  await delay(650);
  assert.equal(panel.launches.length, 1);
  panel.evaluate("finishSave()");
  await starting;
  await waitFor(() => panel.launches.length === 2);
  assert.ok(panel.launches[1].args.includes(entry));
  assert.ok(panel.launches[1].args.includes("--fast-math"));
});

test("obsolete dependencies and closed or native hosts do not trigger embedded reloads", async t => {
  const { root, entry, voice } = fixture(t);
  const panel = await startPanel(t, entry, [entry, voice]);
  panel.sources([entry]);
  fs.writeFileSync(voice, "const value = 2.0\n");
  await delay(650);
  assert.equal(panel.launches.length, 1);

  const next = path.join(root, "next.onda");
  fs.writeFileSync(next, "const value = 1.0\n");
  panel.context.nextInput = next;
  await panel.evaluate("runFile(nextInput)");
  fs.writeFileSync(entry, "const value = 2.0\n");
  await delay(650);
  assert.equal(panel.launches.length, 2);

  panel.evaluate("runPanel.dispose()");
  fs.writeFileSync(next, "const value = 2.0\n");
  await delay(650);
  assert.equal(panel.launches.length, 2);

  const native = createLifecyclePanel({ "run.host": "egui" });
  native.context.input = entry;
  await native.evaluate("runFile(input)");
  assert.equal(native.evaluate("runFileWatcher"), undefined);
  fs.writeFileSync(entry, "const value = 3.0\n");
  await delay(650);
  assert.equal(native.launches.length, 1);
});

test("watch updates retain in-flight changes and batch a burst of file edits", async t => {
  const { entry, voice } = fixture(t);
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([entry, voice]);
  fs.writeFileSync(entry, "const value = 2.0\n");
  fs.writeFileSync(voice, "const value = 3.0\n");
  watcher.update([entry, voice]);
  await waitFor(() => changes > 0);
  assert.equal(changes, 1);
  await delay(650);
  assert.equal(changes, 1);
});

test("watching survives atomic replacement even with a preserved modification time", async t => {
  const { root, entry } = fixture(t);
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([entry]);
  const before = fs.statSync(entry);
  const replacement = path.join(root, "replacement.tmp");
  fs.writeFileSync(replacement, "different contents\n");
  fs.utimesSync(replacement, before.atime, before.mtime);
  fs.renameSync(replacement, entry);
  await waitFor(() => changes === 1);
});

test("acknowledgement and disposal suppress late filesystem notifications", async t => {
  const { entry } = fixture(t);
  let changes = 0;
  const watcher = new RunFileWatcher(() => changes++);
  t.after(() => watcher.dispose());
  watcher.update([entry]);
  fs.writeFileSync(entry, "const value = 2.0\n");
  assert.equal(watcher.isCurrent(entry), false);
  watcher.acknowledge();
  assert.equal(watcher.isCurrent(entry), true);
  await delay(650);
  assert.equal(changes, 0);
  watcher.dispose();
  fs.writeFileSync(entry, "const value = 3.0\n");
  await delay(650);
  assert.equal(changes, 0);
});
