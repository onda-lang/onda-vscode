const assert = require("node:assert/strict");
const test = require("node:test");
const { createLifecyclePanel } = require("./helpers/runLifecycle");

for (const finishMetadataFirst of [false, true]) {
  for (const error of [undefined, "Current source has a compile error"]) {
    test(`a failed Run save preserves stopped metadata: metadata first ${finishMetadataFirst}, error ${!!error}`, async () => {
      const panel = createLifecyclePanel();
      panel.evaluate(`runPanelState.path = '/tmp/lifecycle.onda';
        vscode.window.showErrorMessage = async () => undefined;
        let finishSave;
        vscode.workspace.textDocuments.push({
          uri: vscode.Uri.file('/tmp/canceled.onda'), isDirty: true,
          save: () => new Promise(resolve => { finishSave = () => resolve(false); }),
        });`);
      panel.setDaemonError(error);
      panel.holdMetadata();
      const refreshing = panel.evaluate("refreshStoppedRunMetadata('/tmp/lifecycle.onda')");
      await new Promise(resolve => setImmediate(resolve));
      const child = panel.launches[0].child;
      const starting = panel.evaluate("runFile('/tmp/canceled.onda')");
      assert.equal(child.killed, undefined);
      if (finishMetadataFirst) {
        panel.releaseMetadata();
        await refreshing;
      }
      panel.evaluate("finishSave()");
      await starting;
      if (!finishMetadataFirst) panel.releaseMetadata();
      await refreshing;
      assert.equal(panel.evaluate("runSchemaReady"), true);
      assert.equal(panel.state().path, "/tmp/lifecycle.onda");
      assert.equal(panel.state().error, error ?? null);
      if (!error) assert.equal(panel.state().params[0].name, "updated");
      assert.equal(panel.launches.length, 1);
      assert.equal(panel.evaluate("cancelRunMetadata"), undefined);
      // Completion terminates the daemon; a failed save must not end it early.
      assert.equal(child.killed, true);
    });
  }
}

for (const action of ["stopFile({silent:true})", "runPanel.dispose()", "runFile('/tmp/new.onda')", "deactivate()", "refreshStoppedRunMetadata('/tmp/new.onda')"]) {
  test(`obsolete metadata compilation is terminated by ${action}`, async () => {
    const panel = createLifecyclePanel();
    panel.holdMetadata();
    const refreshing = panel.evaluate("refreshStoppedRunMetadata('/tmp/lifecycle.onda')");
    await new Promise(resolve => setImmediate(resolve));
    const child = panel.launches[0].child;
    panel.evaluate("client=undefined");
    const invalidating = panel.evaluate(action);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(child.killed, true);
    // Simulate an already buffered late reply from the terminated compiler.
    panel.releaseMetadata();
    await Promise.all([refreshing, invalidating]);
  });
}

test("playback source paths survive a UTF-8 character split across pipe chunks", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const bytes = Buffer.from(JSON.stringify({event:"sources",files:["/tmp/café.onda"],complete:true}) + "\n");
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  const stdout = panel.launches.at(-1).child.stdout;
  stdout.emit("data", bytes.subarray(0, split));
  stdout.emit("data", bytes.subarray(split));
  assert.equal(panel.evaluate("runSourceFiles.has('/tmp/café.onda')"), true);
});

for (const cancelled of [true, false]) test(`an older buffer reply cannot replace a newer clear (cancelled: ${cancelled})`, async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  panel.evaluate("refreshRunBuffers=async()=>{};runPanelState.buffers=[{name:'clip',loadedPath:null}]");
  const binding = panel.receive({ type: "bindBufferFile", name: "clip", filePath: "/tmp/slow.wav" });
  const bindRequest = socket.requests.at(-1);
  const clearing = panel.receive({ type: "clearBuffer", name: "clip" });
  const clearRequest = socket.requests.at(-1);
  panel.reply(socket, clearRequest, {});
  await clearing;
  socket.emit("data", JSON.stringify({ id: bindRequest.id, ok: true, cancelled }) + "\n");
  await binding;
  assert.equal(panel.evaluate("preservedRunBufferBindings.get('clip')"), null);
  panel.evaluate("reapplyCachedRunBuffers()");
  assert.equal(socket.requests.at(-1).command, "clearBuffer");
  panel.reply(socket, socket.requests.at(-1), {});
});

test("a canceled buffer load is neither cached nor reported as a failure", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  const binding = panel.receive({ type: "bindBufferFile", name: "clip", filePath: "/tmp/canceled.wav" });
  const request = socket.requests.at(-1);
  socket.emit("data", JSON.stringify({ id: request.id, ok: true, cancelled: true }) + "\n");
  await binding;
  assert.equal(panel.evaluate("preservedRunBufferBindings.has('clip')"), false);
  assert.equal(panel.evaluate("runPanelState.error"), undefined);
});

for (const filePath of ["/tmp/selected.wav", null]) {
  test(`replacing playback preserves a pending buffer edit: ${filePath}`, async t => {
    const panel = createLifecyclePanel();
    t.after(() => panel.evaluate("stopFile({silent:true})"));
    await panel.start();
    panel.connect();
    panel.evaluate(`runPanelState.buffers=[{name:'clip'}];
      preservedRunBufferBindings.set('clip','/tmp/previous.wav');`);
    const superseded = filePath === null
      ? panel.receive({ type: "bindBufferFile", name: "clip", filePath: "/tmp/older.wav" })
      : Promise.resolve();
    const editing = panel.receive(filePath === null
      ? { type: "clearBuffer", name: "clip" }
      : { type: "bindBufferFile", name: "clip", filePath });
    await panel.evaluate('runFile("/tmp/lifecycle.onda",{restart:true})');
    await Promise.all([editing, superseded]);
    assert.equal(panel.evaluate("preservedRunBufferBindings.get('clip')"), filePath);
    const socket = panel.connect();
    panel.evaluate("refreshRunBuffers=async()=>{};runPanelState.buffers=[{name:'clip'}]");
    const restoring = panel.evaluate("reapplyCachedRunBuffers()");
    const request = socket.requests.at(-1);
    assert.equal(request.command, filePath === null ? "clearBuffer" : "bindBufferWav");
    if (filePath !== null) assert.equal(request.path, filePath);
    panel.reply(socket, request, {});
    await restoring;
  });
}

test("a source switch does not inherit pending buffer edits", async t => {
  const panel = createLifecyclePanel();
  t.after(() => panel.evaluate("stopFile({silent:true})"));
  await panel.start();
  panel.connect();
  const editing = panel.receive({ type: "bindBufferFile", name: "clip", filePath: "/tmp/old.wav" });
  await panel.evaluate('runFile("/tmp/new.onda")');
  await editing;
  assert.equal(panel.evaluate("preservedRunBufferBindings.size"), 0);
});

test("a completed clear is not replaced by an older buffer load interrupted by reload", async t => {
  const panel = createLifecyclePanel();
  t.after(() => panel.evaluate("stopFile({silent:true})"));
  await panel.start();
  const socket = panel.connect();
  panel.evaluate("refreshRunBuffers=async()=>{}");
  const binding = panel.receive({ type: "bindBufferFile", name: "clip", filePath: "/tmp/older.wav" });
  const clearing = panel.receive({ type: "clearBuffer", name: "clip" });
  panel.reply(socket, socket.requests.at(-1), {});
  await clearing;
  await panel.evaluate('runFile("/tmp/lifecycle.onda",{restart:true})');
  await binding;
  assert.equal(panel.evaluate("preservedRunBufferBindings.get('clip')"), null);
});

test("a failed buffer replacement retains the previous confirmed binding", async t => {
  const panel = createLifecyclePanel();
  t.after(() => panel.evaluate("stopFile({silent:true})"));
  await panel.start();
  const socket = panel.connect();
  panel.evaluate("vscode.window.showErrorMessage=()=>{};preservedRunBufferBindings.set('clip','/tmp/previous.wav')");
  const editing = panel.receive({ type: "bindBufferFile", name: "clip", filePath: "/tmp/missing.wav" });
  panel.reply(socket, socket.requests.at(-1), {}, "File not found");
  await editing;
  await panel.evaluate('runFile("/tmp/lifecycle.onda",{restart:true})');
  assert.equal(panel.evaluate("preservedRunBufferBindings.get('clip')"), "/tmp/previous.wav");
});

for (const paused of [false, true]) {
  test(`Fast Math recompiles ${paused ? "paused" : "playing"} runs without changing transport intent`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    const socket = panel.connect();
    if (paused) {
      const stopping = panel.receive({ type: "stop" });
      panel.reply(socket, socket.requests.at(-1), {});
      await stopping;
    }
    await panel.receive({ type: "setFastMath", enabled: true });
    assert.equal(panel.state().fastMath, true);
    assert.equal(panel.state().processingRequested, !paused);
    const plays = panel.launches.filter(({ args }) => args.includes("play"));
    assert.equal(plays.length, paused ? 1 : 2);
    if (paused) assert.equal(panel.daemonRequests.at(-2).fast_math, true);
    else assert.equal(plays.at(-1).args.includes("--fast-math"), true);
    const count = panel.launches.length;
    for (const enabled of [true, "false", null]) await panel.receive({ type: "setFastMath", enabled });
    assert.equal(panel.launches.length, count);
  });

  test(`panel audio settings recompile ${paused ? "paused" : "playing"} runs without changing transport intent`, async () => {
    const panel = createLifecyclePanel();
    assert.equal(panel.state().supportsRunSettings, true);
    assert.equal(panel.state().canSetSampleRate, true);
    assert.equal(panel.state().canSetBlockSize, true);
    await panel.evaluate('runFile("/tmp/settings.onda", { fastMath: true })');
    const socket = panel.connect();
    if (paused) {
      const stopping = panel.receive({ type: "stop" });
      panel.reply(socket, socket.requests.at(-1), {});
      await stopping;
    }
    await panel.receive({ type: "setRunSettings", sampleRateHz: 96000, blockSamples: 1024 });
    assert.equal(panel.state().sampleRateHz, 96000);
    assert.equal(panel.state().blockSamples, 1024);
    assert.equal(panel.state().processingRequested, !paused);
    assert.equal(panel.state().fastMath, true);
    const plays = panel.launches.filter(({ args }) => args.includes("play"));
    assert.equal(plays.length, paused ? 1 : 2);
    if (paused) {
      assert.equal(panel.daemonRequests.at(-2).sample_rate_hz, 96000);
      assert.equal(panel.daemonRequests.at(-2).block_samples, 1024);
    } else {
      const args = plays.at(-1).args;
      assert.equal(args[args.indexOf("--sample-rate") + 1], "96000");
      assert.equal(args[args.indexOf("--block-size") + 1], "1024");
    }
    const launchCount = panel.launches.length;
    for (const values of [
      [96000, 1024], [0, 1024], [96000, -1], ["48000", 512],
      [NaN, 512], [768001, 512], [48000, 65537], [48000.5, 512],
    ]) {
      await panel.receive({ type: "setRunSettings", sampleRateHz: values[0], blockSamples: values[1] });
    }
    assert.equal(panel.launches.length, launchCount);
    assert.equal(panel.state().sampleRateHz, 96000);
    assert.equal(panel.state().blockSamples, 1024);
  });
}

test("failed stopped recompilation retains the selected audio settings", async () => {
  const panel = createLifecyclePanel();
  panel.evaluate('runPanelState.path = "/tmp/settings.onda"');
  panel.setDaemonError("Compile failed");
  await panel.receive({ type: "setRunSettings", sampleRateHz: 96000, blockSamples: 1024 });
  assert.match(panel.state().error, /Compile failed/);
  assert.equal(panel.state().sampleRateHz, 96000);
  assert.equal(panel.state().blockSamples, 1024);
  assert.equal(panel.state().processingRequested, false);
  assert.equal(panel.launches.some(({ args }) => args.includes("play")), false);
});

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
      loadedSamples: 100, loadedChannels: 2, loadedSampleRate: 48000,
      waveform: { minimums: [-1], maximums: [1] } }]`);
    const playbackLaunches = () => panel.launches.filter(({ args }) => args.includes("play")).length;
    await panel.receive(binding === null
      ? { type: "clearBuffer", name: "clip" }
      : { type: "bindBufferFile", name: "clip", filePath: binding });
    assert.equal(playbackLaunches(), 1);
    assert.equal(panel.state().running, false);
    assert.equal(panel.state().error, null);
    assert.equal(panel.state().buffers[0].loadedPath, binding);
    for (const field of ["loadedSamples", "loadedChannels", "loadedSampleRate", "waveform"]) {
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
      loadedPath: binding, loadedSamples: binding ? 1200 : null,
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
        loadedSamples: 80, loadedChannels: 1, loadedSampleRate: 44100, waveform: { minimums: [-1] } },
      { name: "new_clip", index: 0, loadedPath: "/tmp/new.wav", loadedSamples: 300 },
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
    assert.equal(newBuffer.loadedSamples, 300);
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

test("a changed floating default's zero sign resets the cached parameter", () => {
  const panel = createLifecyclePanel();
  const merged = panel.evaluate(`
    const normalizeRunParams = require('./runMetadata').normalizeRunParams;
    const before = normalizeRunParams([{name:'gain', type:'f64', defaultRepr:'0'}]);
    const after = normalizeRunParams([{name:'gain', type:'f64', defaultRepr:'-0'}]);
    mergeRunParams(after, [{...before[0], value:0.5}])
  `);
  assert.equal(merged[0].value, "-0");
});

test("Reset uses the acknowledged native reset instead of smoothed parameter writes", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  panel.evaluate(`runPanelState.params = require('./runMetadata').normalizeRunParams([{name:'gain',type:'f64',value:1,defaultRepr:'-0'}])`);
  const resetting = panel.receive({type:"resetParams"});
  const request = socket.requests.at(-1);
  assert.equal(request.command, "resetParams");
  assert.equal(typeof request.id, "number");
  panel.reply(socket, request, {});
  await resetting;
  assert.equal(panel.evaluate("runPanelState.params[0].value"), "-0");
  assert.equal(socket.requests.some(request => request.command === "setParam"), false);
});

for (const newerEdit of [false, true]) test(`a rejected Reset preserves the accepted value (newer edit: ${newerEdit})`, async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  panel.evaluate(`runPanelState.params = require('./runMetadata').normalizeRunParams([{name:'gain',type:'f64',value:1,default:0}])`);
  const resetting = panel.receive({type:"resetParams"});
  const request = socket.requests.at(-1);
  if (newerEdit) await panel.receive({type:"setParam", name:"gain", value:0.5});
  panel.reply(socket, request, undefined, "Reset failed");
  await resetting;
  assert.equal(panel.evaluate("runPanelState.params[0].value"), newerEdit ? 0.5 : 1);
  assert.equal(panel.evaluate("runPanelState.error"), "Reset failed");
});

test("an obsolete Reset failure cannot replace a newer Reset", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  panel.evaluate(`runPanelState.params = require('./runMetadata').normalizeRunParams([{name:'gain',type:'f64',value:1,default:0}])`);
  const first = panel.receive({type:"resetParams"});
  const firstRequest = socket.requests.at(-1);
  const second = panel.receive({type:"resetParams"});
  const secondRequest = socket.requests.at(-1);
  panel.reply(socket, firstRequest, undefined, "Obsolete failure");
  await first;
  panel.reply(socket, secondRequest, {});
  await second;
  assert.equal(panel.evaluate("runPanelState.error"), undefined);
  assert.equal(panel.evaluate("runPanelState.params[0].value"), 0);
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

for (const existingProcess of [false, true]) {
  test(`Play from the run panel preserves keyboard focus (existing process: ${existingProcess})`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    if (existingProcess) {
      const socket = panel.connect();
      const pausing = panel.receive({ type: "stop" });
      panel.reply(socket, socket.requests.at(-1), {});
      await pausing;
    } else {
      await panel.evaluate("stopFile({silent:true})");
    }
    panel.panelReveals.length = 0;
    const starting = panel.receive({ type: "start" });
    if (existingProcess) {
      await new Promise(resolve => setImmediate(resolve));
      const socket = panel.sockets.at(-1);
      assert.equal(socket.requests.at(-1).command, "play");
      panel.reply(socket, socket.requests.at(-1), {});
    }
    await starting;
    assert.equal(panel.panelReveals.length, 1);
    assert.equal(panel.panelReveals[0].preserveFocus, true);
  });
}

for (const message of [
  { type: "setInputDevice", name: "Microphone" },
  { type: "setOutputDevice", name: "Headphones" },
  { type: "setMidiInputDevice", name: "MIDI Controller" },
  { type: "setFastMath", enabled: true },
  { type: "setRunSettings", sampleRateHz: 96000, blockSamples: 512 },
  { type: "setRunSettings", sampleRateHz: 48000, blockSamples: 1024 },
]) {
  test(`${JSON.stringify(message)} preserves keyboard focus when restarting playback`, async () => {
    const panel = createLifecyclePanel();
    await panel.start();
    panel.connect();
    panel.panelReveals.length = 0;
    await panel.receive(message);
    assert.equal(panel.launches.length, 2);
    assert.equal(panel.panelReveals.length, 1);
    assert.equal(panel.panelReveals[0].preserveFocus, true);
  });
}

test("creating a run panel for a background reload preserves focus", () => {
  const panel = createLifecyclePanel();
  panel.evaluate("runPanel = undefined; ensureRunPanel(true)");
  assert.equal(panel.panelCreations.at(-1).preserveFocus, true);
});
