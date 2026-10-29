const assert = require("node:assert/strict");
const test = require("node:test");
const { createLifecyclePanel } = require("./helpers/runLifecycle");

test("panel Stop cancels recovery after a compile error", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  panel.launches[0].child.emit("exit", 1, null);
  assert.equal(panel.state().processingRequested, true);
  await panel.receive({ type: "stop" });
  assert.equal(panel.state().processingRequested, false);
  await panel.save();
  assert.equal(panel.launches.filter(({ args }) => args.includes("play")).length, 1);
  assert.equal(panel.state().running, false);
  assert.equal(panel.state().params[0].name, "updated");
});

test("panel Stop cancels a launch still waiting for path resolution", async () => {
  const panel = createLifecyclePanel();
  const starting = panel.start();
  await panel.receive({ type: "stop" });
  await starting;
  assert.equal(panel.launches.length, 0);
  assert.equal(panel.evaluate("runProcessingRequested"), false);
});

for (const input of ["/tmp/lifecycle.onda", "/tmp/new.onda"]) {
  for (const finishSaveFirst of [false, true]) {
    test(`connected Stop cancels a Run waiting for a save: ${input}, save finishes first: ${finishSaveFirst}`, async () => {
      const panel = createLifecyclePanel();
      await panel.start();
      const socket = panel.connect();
      panel.context.pendingInput = input;
      panel.evaluate(`
        let finishSave;
        vscode.workspace.textDocuments.push({
          uri: vscode.Uri.file(pendingInput), isDirty: true,
          save() { return new Promise(resolve => { finishSave = () => resolve(true); }); },
        });
      `);
      const starting = panel.evaluate("runFile(pendingInput)");
      const stopping = panel.receive({ type: "stop" });
      const pauseRequest = socket.requests.at(-1);
      assert.equal(pauseRequest.command, "pause");
      if (finishSaveFirst) {
        panel.evaluate("finishSave()");
        await starting;
      }
      panel.reply(socket, pauseRequest, {});
      await stopping;
      if (!finishSaveFirst) {
        panel.evaluate("finishSave()");
        await starting;
      }
      assert.equal(panel.launches.length, 1);
      assert.equal(panel.launches[0].child.killed, undefined);
      assert.equal(panel.state().path, "/tmp/lifecycle.onda");
      assert.equal(panel.state().running, false);
      assert.equal(panel.state().processingRequested, false);
      assert.equal(panel.state().error, null);
    });
  }
}

test("overlapping Run commands launch only the most recent request", async () => {
  const panel = createLifecyclePanel();
  await Promise.all([
    panel.evaluate('runFile("/tmp/old.onda")'),
    panel.evaluate('runFile("/tmp/new.onda", { fastMath: true })'),
  ]);
  assert.equal(panel.launches.length, 1);
  assert.ok(panel.launches[0].args.includes("/tmp/new.onda"));
  assert.equal(panel.state().path, "/tmp/new.onda");
  assert.equal(panel.state().fastMath, true);
});

test("saving a paused run refreshes metadata without resuming and keeps compile options", async () => {
  const panel = createLifecyclePanel({ "run.sampleRate": 96000, "run.blockSize": 1024 });
  await panel.evaluate('runFile("/tmp/lifecycle.onda", { fastMath: true })');
  const socket = panel.connect();
  const pause = panel.receive({ type: "stop" });
  panel.reply(socket, socket.requests.at(-1), {});
  await pause;
  await panel.save();
  assert.equal(panel.launches.filter(({ args }) => args.includes("play")).length, 1);
  assert.equal(panel.launches[0].child.killed, true);
  assert.equal(panel.state().running, false);
  assert.equal(panel.state().params[0].name, "updated");
  assert.deepEqual(panel.daemonRequests.map(({ command }) => command), ["run_sources", "initialize", "run_metadata"]);
  assert.equal(panel.daemonRequests[1].sample_rate_hz, 96000);
  assert.equal(panel.daemonRequests[1].block_samples, 1024);
  assert.equal(panel.daemonRequests[1].fast_math, true);
  assert.equal(panel.daemonRequests[1].param_smoothing_seconds, 0.03);
});

for (const outcome of ["success", "failure"]) {
  test(`an outdated stopped compile cannot overwrite a newer run: ${outcome}`, async () => {
    const panel = createLifecyclePanel();
    panel.evaluate(`
      runPanelState.path = "/tmp/lifecycle.onda";
      let finishMetadata;
      loadStoppedRunMetadata = () => new Promise((resolve, reject) => {
        finishMetadata = ${outcome === "success" ? "resolve" : "reject"};
      });
    `);
    const saving = panel.save();
    await panel.evaluate('runFile("/tmp/new.onda")');
    panel.evaluate(outcome === "success"
      ? 'finishMetadata({ params: [{ name: "stale", type: "f32" }] })'
      : 'finishMetadata(new Error("stale compile error"))');
    await saving;
    assert.equal(panel.state().path, "/tmp/new.onda");
    assert.equal(panel.state().error, null);
    assert.equal(panel.state().params.length, 0);
  });
}

for (const input of ["/tmp/lifecycle.onda", "/tmp/new.onda"]) {
  test(`a newer Run wins while a paused save shuts down its process: ${input}`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    const socket = panel.connect();
    const pausing = panel.receive({ type: "stop" });
    panel.reply(socket, socket.requests.at(-1), {});
    await pausing;

    const saving = panel.save();
    const starting = panel.evaluate(`runFile(${JSON.stringify(input)})`);
    await Promise.all([saving, starting]);
    assert.equal(panel.launches.length, 2);
    assert.ok(panel.launches[1].args.includes("play"));
    assert.ok(panel.launches[1].args.includes(input));
    assert.equal(panel.state().path, input);
    assert.equal(panel.daemonRequests.length, 0);
    assert.equal(panel.evaluate("runProcessingRequested"), true);
  });
}

test("Stop cancels a paused save before metadata discovery starts", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  const pausing = panel.receive({ type: "stop" });
  panel.reply(socket, socket.requests.at(-1), {});
  await pausing;
  const saving = panel.save();
  await panel.receive({ type: "stop" });
  await saving;
  assert.equal(panel.launches.length, 1);
  assert.equal(panel.daemonRequests.length, 0);
  assert.equal(panel.state().running, false);
});

for (const operation of [
  "refreshRunParams()", "refreshRunBuffers()", "refreshRunEvents()", "refreshRunDevices()",
  'bindRunBufferFile("clip", "/tmp/old.wav", { silent: true })',
  'clearRunBuffer("clip")', 'triggerRunEvent("bang", [])', "setRunProcessing(false)",
]) {
  test(`ended sessions cannot publish control results or errors: ${operation}`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    const oldSocket = panel.connect();
    panel.evaluate('runPanelState.events = [{ name: "bang", index: 0, args: [] }]');
    const pending = panel.evaluate(operation);
    await panel.evaluate('runFile("/tmp/new.onda")');
    await pending;
    oldSocket.emit("error", new Error("stale connection error"));
    oldSocket.emit("data", JSON.stringify({ event: "print", text: "stale output\n" }) + "\n");
    assert.equal(panel.state().path, "/tmp/new.onda");
    assert.equal(panel.state().error, null);
    assert.equal(panel.state().logText, "");
    assert.equal(panel.evaluate("runProcessingRequested"), true);
    assert.equal(panel.evaluate("preservedRunBufferBindings.size"), 0);
  });
}

test("a response already received cannot update a replacement session", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  const pending = panel.evaluate("refreshRunParams()");
  panel.reply(socket, socket.requests.at(-1), { params: [{ name: "stale", type: "f32" }] });
  // Replace the session before the async continuation consumes the reply.
  panel.evaluate('closeRunControlSocket(); runPanelState.params = []; postRunPanelState()');
  await pending;
  assert.equal(panel.state().params.length, 0);
  assert.equal(panel.state().error, null);
});

test("out-of-order transport replies respect the most recent Play/Stop action", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  const playing = panel.evaluate("setRunProcessing(true)");
  const playRequest = socket.requests.at(-1);
  const stopping = panel.receive({ type: "stop" });
  const stopRequest = socket.requests.at(-1);
  panel.reply(socket, stopRequest, {});
  await stopping;
  panel.reply(socket, playRequest, {});
  await playing;
  assert.equal(panel.state().running, false);
  assert.equal(panel.evaluate("runProcessingRequested"), false);
});

for (const error of [undefined, "play failed"]) {
  test(`repeated Play preserves the pending playback response: ${error ?? "success"}`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    const socket = panel.connect();
    const pausing = panel.receive({ type: "stop" });
    panel.reply(socket, socket.requests.at(-1), {});
    await pausing;

    const playing = panel.receive({ type: "start" });
    await new Promise(resolve => setImmediate(resolve));
    const request = socket.requests.at(-1);
    assert.equal(request.command, "play");
    await panel.receive({ type: "start" });
    assert.equal(socket.requests.filter(({ command }) => command === "play").length, 1);
    assert.equal(panel.launches.length, 1);

    panel.reply(socket, request, {}, error);
    await playing;
    assert.equal(panel.state().running, !error);
    assert.equal(panel.state().processingRequested, !error);
    assert.equal(panel.state().status, error ? "Stopped" : "Running");
    assert.equal(panel.state().error, error ?? null);
    if (error) {
      const retrying = panel.receive({ type: "start" });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(socket.requests.filter(({ command }) => command === "play").length, 2);
      panel.reply(socket, socket.requests.at(-1), {});
      await retrying;
      assert.equal(panel.state().running, true);
      assert.equal(panel.state().error, null);
    }
  });
}

for (const fastMath of [false, true]) {
  test(`Run saves dirty code once and compiles it with the requested math mode: ${fastMath}`, async () => {
    const panel = createLifecyclePanel();
    await panel.evaluate('runFile("/tmp/lifecycle.onda", { fastMath: true })');
    panel.evaluate(`
      let inputSaveCount = 0;
      const document = {
        languageId: "onda", isDirty: true, uri: vscode.Uri.file("/tmp/lifecycle.onda"),
        async save() {
          inputSaveCount++;
          this.isDirty = false;
          await restartRunForSavedDocument(this);
          return true;
        },
      };
      vscode.workspace.textDocuments.push(document);
    `);
    await panel.evaluate(`runFile("/tmp/lifecycle.onda", { fastMath: ${fastMath} })`);
    assert.equal(panel.evaluate("inputSaveCount"), 1);
    assert.equal(panel.launches.length, 2);
    assert.equal(panel.launches.at(-1).args.includes("--fast-math"), fastMath);
    assert.equal(panel.state().fastMath, fastMath);
    assert.equal(panel.evaluate("runInputSaves.size"), 0);
  });
}

test("clearing a project buffer remains cleared after recompiling", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  let socket = panel.connect();
  const clearing = panel.evaluate('clearRunBuffer("clip")');
  panel.reply(socket, socket.requests.at(-1), {});
  await Promise.resolve();
  panel.reply(socket, socket.requests.at(-1), { buffers: [] });
  await clearing;
  await panel.save();
  socket = panel.connect();
  panel.evaluate('runPanelState.buffers = [{ name: "clip" }]; reapplyCachedRunBuffers()');
  assert.equal(socket.requests.at(-1).command, "clearBuffer");
  const reply = socket.requests.at(-1);
  panel.reply(socket, reply, {});
  await Promise.resolve();
  panel.reply(socket, socket.requests.at(-1), { buffers: [] });
  await Promise.resolve();
  assert.equal(panel.evaluate('preservedRunBufferBindings.get("clip")'), null);
});

for (const binding of [null, "/tmp/selected.wav"]) {
  test(`buffer edits after a stopped save are retained and replayed on Play: ${binding}`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    let socket = panel.connect();
    const pausing = panel.receive({ type: "stop" });
    panel.reply(socket, socket.requests.at(-1), {});
    await pausing;
    await panel.save();
    assert.equal(panel.state().connected, false);

    // Replacing a previously loaded asset must also discard its waveform.
    panel.evaluate(`runPanelState.buffers = [{ name: "clip", loadedPath: "/tmp/default.wav",
      loadedFrames: 100, loadedChannels: 2, loadedSampleRate: 48000,
      waveform: { minimums: [-1], maximums: [1] } }]`);
    const playbackLaunches = () => panel.launches.filter(({ args }) => args.includes("play")).length;
    await panel.receive(binding === null
      ? { type: "clearBuffer", name: "clip" }
      : { type: "bindBufferFile", name: "clip", filePath: binding });
    assert.equal(playbackLaunches(), 1);
    assert.equal(panel.state().running, false);
    assert.equal(panel.state().error, null);
    assert.equal(panel.state().buffers[0].loadedPath, binding);
    for (const field of ["loadedFrames", "loadedChannels", "loadedSampleRate", "waveform"]) {
      assert.equal(panel.state().buffers[0][field], null);
    }

    await panel.save();
    assert.equal(panel.state().buffers[0].loadedPath, binding);
    await panel.receive({ type: "start" });
    assert.equal(playbackLaunches(), 2);
    socket = panel.connect();
    panel.evaluate('runPanelState.buffers = [{ name: "clip" }]; reapplyCachedRunBuffers()');
    const request = socket.requests.at(-1);
    assert.equal(request.command, binding === null ? "clearBuffer" : "bindBufferWav");
    assert.equal(request.name, "clip");
    if (binding !== null) assert.equal(request.path, binding);
    panel.reply(socket, request, {});
    await Promise.resolve();
    panel.reply(socket, socket.requests.at(-1), { buffers: [{ name: "clip", loadedPath: binding }] });
    await Promise.resolve();
  });

  test(`stopped saves retain a buffer override alongside new declarations: ${binding}`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    const socket = panel.connect();
    const changing = panel.evaluate(binding === null
      ? 'clearRunBuffer("clip")'
      : `bindRunBufferFile("clip", ${JSON.stringify(binding)})`);
    panel.reply(socket, socket.requests.at(-1), {});
    await Promise.resolve();
    const loaded = {
      loadedPath: binding, loadedFrames: binding ? 1200 : null,
      loadedChannels: binding ? 2 : null, loadedSampleRate: binding ? 48000 : null,
      waveform: binding ? { minValue: -1, maxValue: 1, minimums: [-0.5], maximums: [0.5] } : null,
    };
    panel.reply(socket, socket.requests.at(-1), { buffers: [{ name: "clip", index: 0, ...loaded }] });
    await changing;
    const pausing = panel.receive({ type: "stop" });
    panel.reply(socket, socket.requests.at(-1), {});
    await pausing;

    panel.evaluate(`loadStoppedRunMetadata = async () => ({ buffers: [
      { name: "clip", index: 1, type: "f32", channelsKind: "dynamic", loadedPath: "/tmp/default.wav",
        loadedFrames: 80, loadedChannels: 1, loadedSampleRate: 44100, waveform: { minimums: [-1] } },
      { name: "new_clip", index: 0, loadedPath: "/tmp/new.wav", loadedFrames: 300 },
    ] })`);
    await panel.save();
    const [buffer, newBuffer] = panel.state().buffers;
    assert.equal(buffer.index, 1);
    assert.equal(buffer.type, "f32");
    assert.equal(buffer.channelsKind, "dynamic");
    for (const key of Object.keys(loaded)) {
      assert.deepEqual(JSON.parse(JSON.stringify(buffer[key])), loaded[key]);
    }
    assert.equal(newBuffer.loadedPath, "/tmp/new.wav");
    assert.equal(newBuffer.loadedFrames, 300);
    assert.equal(panel.state().running, false);
    assert.equal(panel.state().error, null);
    assert.equal(panel.launches.length, 1);

    // A retained binding must not resurrect a removed declaration.
    panel.evaluate('loadStoppedRunMetadata = async () => ({ buffers: [] })');
    await panel.save();
    assert.equal(panel.state().buffers.length, 0);
  });
}

test("a buffer picker opened for another input cannot change the stopped session", async () => {
  const panel = createLifecyclePanel();
  panel.evaluate(`
    runPanelState.path = "/tmp/old.onda";
    runPanelState.buffers = [{ name: "clip" }];
    let finishPicker;
    vscode.window.showOpenDialog = () => new Promise(resolve => { finishPicker = resolve; });
  `);
  const picking = panel.evaluate('chooseRunBufferFile("clip")');
  panel.evaluate(`
    runPanelState.path = "/tmp/new.onda";
    finishPicker([vscode.Uri.file("/tmp/old.wav")]);
  `);
  await picking;
  assert.equal(panel.evaluate("preservedRunBufferBindings.size"), 0);
  assert.equal(panel.evaluate("runPanelState.buffers[0].loadedPath"), undefined);
});

test("parameter edits survive identical declarations but changed defaults reset their values", () => {
  const panel = createLifecyclePanel();
  const unchanged = panel.evaluate(`
    const normalizeRunParams = require("./runMetadata").normalizeRunParams;
    const params = normalizeRunParams([{ name: "gain", type: "f32", default: 0.5 }]);
    const edited = [{ ...params[0], value: 0.8 }];
    mergeRunParams(params, edited)
  `);
  assert.equal(unchanged[0].value, 0.8);
  const updated = panel.evaluate('mergeRunParams(normalizeRunParams([{ name: "gain", type: "f32", default: 0.25 }]), edited)');
  assert.equal(updated[0].value, 0.25);
});

for (const [change, expected] of [
  [{}, 99],
  [{ type: "bool", default: false }, false],
  [{ name: "velocity", default: 0.5 }, 0.5],
  [{ default: 64 }, 64],
  [{ shape: { kind: "scalar", encoding: "i32" }, default: 42 }, 42],
]) {
  test(`event argument edits follow compatible declarations: ${JSON.stringify(change)}`, () => {
    const panel = createLifecyclePanel();
    panel.context.argChange = change;
    const merged = panel.evaluate(`
      const oldEvent = { name: "note", index: 0,
        args: [{ name: "key", type: "i32", default: 60, value: 99 }] };
      mergeRunEvents([{ ...oldEvent, args: [{ ...oldEvent.args[0], ...argChange }] }], [oldEvent])
    `);
    assert.equal(merged[0].args[0].value, expected);
  });
}

test("a pending pause takes effect before a save decides whether to resume", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  panel.connect();
  const pause = panel.receive({ type: "stop" });
  await panel.save();
  await pause;
  assert.equal(panel.launches.filter(({ args }) => args.includes("play")).length, 1);
  assert.equal(panel.state().running, false);
  assert.equal(panel.state().error, null);
});

test("the run view shows compilation until the new process is ready", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  assert.match(panel.state().status, /^Compiling/);
  assert.equal(panel.state().running, false);
  assert.equal(panel.state().processingRequested, true);
  panel.launches.at(-1).child.stdout.emit("data", Buffer.from(JSON.stringify({
    event: "ready", port: 1234, params: [],
  }) + "\n"));
  assert.equal(panel.state().running, true);
  assert.equal(panel.state().status, "Running");
});

test("saving a selected project manifest reloads it despite its JSON language ID", async () => {
  const panel = createLifecyclePanel();
  await panel.evaluate('runFile("/tmp/voice.ondaproject")');
  await panel.evaluate(`restartRunForSavedDocument({
    languageId: "json", uri: vscode.Uri.file("/tmp/voice.ondaproject"),
  })`);
  assert.equal(panel.launches.length, 2);
  assert.equal(panel.launches[0].child.killed, true);
  assert.ok(panel.launches[1].args.includes("/tmp/voice.ondaproject"));
});

test("closing the run view ends the session and subsequent saves do not compile it", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  panel.evaluate("runPanel.dispose()");
  await panel.save();
  assert.equal(panel.launches.length, 1);
  assert.equal(panel.launches[0].child.killed, true);
  assert.equal(panel.evaluate("runPanelState.path"), undefined);
  assert.equal(panel.evaluate("runPath"), undefined);
  assert.equal(panel.evaluate("runProcessingRequested"), false);
});

test("a failed pause cannot cancel a newer Run request still resolving its input", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  const pausing = panel.receive({ type: "stop" });
  panel.reply(socket, socket.requests.at(-1), undefined, "pause failed");
  const starting = panel.evaluate('runFile("/tmp/new.onda")');
  await Promise.all([pausing, starting]);
  assert.equal(panel.launches.length, 2);
  assert.equal(panel.state().path, "/tmp/new.onda");
  assert.equal(panel.state().error, null);
  assert.equal(panel.evaluate("runProcessingRequested"), true);
});

test("saving transitive dependencies restarts the selected input and unrelated saves do nothing", async () => {
  const panel = createLifecyclePanel();
  await panel.evaluate('runFile("/tmp/lifecycle.onda", { fastMath: true })');
  panel.sources(["/tmp/lifecycle.onda", "/tmp/lib/voice.onda", "/tmp/lib/osc.onda"]);
  await panel.savePath("/tmp/lib/unrelated.onda");
  assert.equal(panel.launches.length, 1);
  for (const file of ["/tmp/lib/voice.onda", "/tmp/lib/osc.onda"]) {
    await panel.savePath(file);
    assert.ok(panel.launches.at(-1).args.includes("/tmp/lifecycle.onda"));
    assert.equal(panel.launches.at(-1).args.includes(file), false);
    assert.equal(panel.launches.at(-1).args.includes("--fast-math"), true);
  }
  assert.equal(panel.launches.length, 3);
  panel.sources(["/tmp/lifecycle.onda", "/tmp/lib/new.onda"]);
  await panel.savePath("/tmp/lib/voice.onda");
  await panel.savePath("/tmp/lib/osc.onda");
  assert.equal(panel.launches.length, 3);
  await panel.savePath("/tmp/lib/new.onda");
  assert.equal(panel.launches.length, 4);
});

for (const input of ["/tmp/lifecycle.onda", "/tmp/project.ondaproject"]) {
  for (const state of ["playing", "failed", "stopped"]) {
    test(`dependency saves preserve dirty entry edits: ${input}, ${state}`, async () => {
      const panel = createLifecyclePanel();
      panel.context.inputPath = input;
      await panel.evaluate("runFile(inputPath)");
      panel.sources([input, "/tmp/voice.onda"]);
      if (state === "failed") panel.launches[0].child.emit("exit", 1, null);
      if (state === "stopped") await panel.evaluate("stopFile({ silent: true })");
      panel.evaluate(`
        let inputSaveCount = 0;
        const document = {
          uri: vscode.Uri.file(inputPath), isDirty: true,
          async save() { inputSaveCount++; this.isDirty = false; return true; },
        };
        vscode.workspace.textDocuments.push(document);
      `);

      await panel.savePath("/tmp/voice.onda");
      assert.equal(panel.evaluate("inputSaveCount"), 0);
      assert.equal(panel.evaluate("document.isDirty"), true);
      const launch = panel.launches.at(-1);
      if (state === "stopped") {
        assert.ok(launch.args.includes("daemon"));
        assert.equal(panel.state().running, false);
      } else {
        assert.ok(launch.args.includes("play"));
        assert.ok(launch.args.includes(input));
        assert.equal(panel.state().processingRequested, true);
      }
    });
  }
}

test("incomplete discovery retains imports so fixing a dependency resumes a failed run", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  panel.sources(["/tmp/lifecycle.onda", "/tmp/voice.onda"]);
  await panel.save();
  panel.sources(["/tmp/lifecycle.onda", "/tmp/missing.onda"], false);
  panel.launches.at(-1).child.emit("exit", 1, null);
  await panel.savePath("/tmp/voice.onda");
  assert.equal(panel.launches.length, 3);
  panel.launches.at(-1).child.emit("exit", 1, null);
  await panel.savePath("/tmp/missing.onda");
  assert.equal(panel.launches.length, 4);
  assert.ok(panel.launches.at(-1).args.includes("/tmp/lifecycle.onda"));
});

test("a switched input cannot inherit dependencies from old process output", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const previous = panel.launches[0].child;
  panel.sources(["/tmp/lifecycle.onda", "/tmp/voice.onda"]);
  await panel.evaluate('runFile("/tmp/new.onda")');
  previous.stdout.emit("data", Buffer.from(JSON.stringify({
    event: "sources", files: ["/tmp/voice.onda"], complete: true,
  }) + "\n"));
  await panel.savePath("/tmp/voice.onda");
  assert.equal(panel.launches.length, 2);
});

test("stopped discovery updates dependencies even on compile failure, then refreshes all controls", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  await panel.evaluate('stopFile({ silent: true })');
  panel.setDaemonGraph({ files: ["/tmp/lifecycle.onda", "/tmp/missing.onda"], complete: false });
  panel.setDaemonError("missing import");
  await panel.save();
  assert.match(panel.state().error, /missing import/);
  panel.setDaemonError(undefined);
  panel.setDaemonGraph({ files: ["/tmp/lifecycle.onda", "/tmp/missing.onda"], complete: true });
  await panel.savePath("/tmp/missing.onda");
  assert.equal(panel.state().running, false);
  assert.equal(panel.state().error, null);
  assert.equal(panel.state().params[0].name, "updated");
  assert.equal(panel.state().buffers[0].name, "clip");
  assert.equal(panel.state().events[0].name, "bang");
  assert.equal(panel.launches.filter(({ args }) => args.includes("play")).length, 1);
  assert.ok(panel.daemonRequests.filter(({ command }) => command === "run_metadata")
    .every(({ path }) => path === "/tmp/lifecycle.onda"));
});

test("project dependencies include its entry, imports, and declared assets", async () => {
  const panel = createLifecyclePanel();
  await panel.evaluate('runFile("/tmp/project.ondaproject")');
  panel.sources(["/tmp/project.ondaproject", "/tmp/code/main.onda", "/tmp/code/voice.onda", "/tmp/assets/clip.ondabuffer"]);
  for (const file of ["/tmp/code/main.onda", "/tmp/code/voice.onda", "/tmp/assets/clip.ondabuffer"]) {
    await panel.savePath(file);
    assert.ok(panel.launches.at(-1).args.includes("/tmp/project.ondaproject"));
  }
  assert.equal(panel.launches.length, 4);
});

for (const savedFile of ["/tmp/lifecycle.onda", "/tmp/voice.onda"]) {
  test(`automatic reloads preserve editor focus, including compile recovery: ${savedFile}`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    panel.sources(["/tmp/lifecycle.onda", "/tmp/voice.onda"]);
    panel.panelReveals.length = 0;
    await panel.savePath(savedFile);
    assert.equal(panel.panelReveals.length, 1);
    assert.equal(panel.panelReveals[0].preserveFocus, true);

    panel.launches.at(-1).child.emit("exit", 1, null);
    panel.panelReveals.length = 0;
    await panel.savePath(savedFile);
    assert.equal(panel.panelReveals.length, 1);
    assert.equal(panel.panelReveals[0].preserveFocus, true);
  });
}

test("explicit Run commands still focus the run view, including an existing process", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  assert.equal(panel.panelCreations[0].preserveFocus, false);
  assert.equal(panel.panelReveals.at(-1).preserveFocus, false);
  panel.panelReveals.length = 0;
  await panel.start();
  assert.equal(panel.panelReveals.length, 1);
  assert.equal(panel.panelReveals[0].preserveFocus, false);
});

test("creating a run panel for a background reload preserves focus", () => {
  const panel = createLifecyclePanel();
  panel.evaluate("runPanel = undefined; ensureRunPanel(true)");
  assert.equal(panel.panelCreations.at(-1).preserveFocus, true);
});
