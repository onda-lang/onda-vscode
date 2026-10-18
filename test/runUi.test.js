const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRunPanel } = require("./helpers/runPanel");

const runHtml = fs.readFileSync(
  path.join(__dirname, "..", "ui", "run", "run.html"),
  "utf8",
);
const buffersScript = fs.readFileSync(
  path.join(__dirname, "..", "ui", "run", "buffers.js"),
  "utf8",
);

function renderTransport(state) {
  const messages = [];
  let clickStop;
  let keydown;
  const context = {
    state,
    heroControlsNode: { classList: { toggle() {} } },
    transportNode: { contains: () => false },
    startButton: {},
    stopButton: {
      addEventListener(type, listener) { clickStop = listener; },
      click() { if (!this.disabled) clickStop(); },
    },
    document: { addEventListener(type, listener) { keydown = listener; } },
    releaseAllVirtualMidiNotes() {},
    hostBridge: { postMessage(message) { messages.push(message); } },
  };
  const source = runHtml.match(/      function renderTransport\(\) \{[\s\S]*?\n      \}/)?.[0];
  const stopListener = runHtml.match(/      stopButton\.addEventListener\("click", \(\) => \{[\s\S]*?\n      \}\);/)?.[0];
  const shortcutListener = runHtml.match(/      document\.addEventListener\("keydown", \(event\) => \{[\s\S]*?\n      \}, \{ capture: true \}\);/)?.[0];
  assert.ok(source, "the bundled view must render transport controls");
  assert.ok(stopListener);
  assert.ok(shortcutListener);
  vm.runInNewContext(`${source}\n${stopListener}\n${shortcutListener}\nrenderTransport();`, context);
  return {
    start: context.startButton, stop: context.stopButton, messages,
    stopShortcut() {
      keydown({ key: ".", code: "Period", ctrlKey: true, preventDefault() {}, stopPropagation() {} });
    },
  };
}

function renderBuffers(buffers, canEdit = true) {
  const elements = [];
  const messages = [];
  function createElement(tag) {
    const element = {
      tag, children: [], dataset: {},
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      querySelector() { return createElement("text"); },
      addEventListener(type, listener) { this[type] = listener; },
    };
    elements.push(element);
    return element;
  }
  const document = {
    createElement, createDocumentFragment: () => createElement("fragment"), addEventListener() {},
  };
  const context = { document };
  vm.runInNewContext(buffersScript, context);
  const node = createElement("root");
  node.ownerDocument = document;
  const { BufferView } = context.__ONDA_RUN_BUFFERS__;
  const view = new BufferView(node, { postMessage: message => messages.push(message) }, () => canEdit);
  view.drawWaveforms = () => {};
  view.render(buffers);
  return { buttons: elements.filter(element => element.tag === "button"), messages };
}

test("a buffer selected while stopped can be replaced and cleared before Play", async () => {
  const panel = createRunPanel();
  panel.evaluate(`
    runPanelState.path = "/tmp/stopped.onda";
    runPanelState.buffers = [{ name: "clip", loadedPath: null, loadedFrames: null }];
  `);
  await panel.receive({ type: "bindBufferFile", name: "clip", filePath: "/tmp/selected.wav" });
  const state = panel.messages.at(-1).state;
  assert.equal(state.running, false);
  assert.equal(state.connected, false);
  assert.equal(state.buffers[0].loadedFrames, null);
  const { buttons: [choose, clear], messages } = renderBuffers(state.buffers);
  assert.equal(choose.textContent, "Replace");
  assert.equal(choose.disabled, false);
  assert.equal(clear.hidden, false);
  assert.equal(clear.disabled, false);
  clear.click();
  assert.equal(messages[0].type, "clearBuffer");
  assert.equal(messages[0].name, "clip");
  await panel.receive(messages[0]);
  assert.equal(panel.evaluate('preservedRunBufferBindings.get("clip")'), null);
  const cleared = panel.messages.at(-1).state;
  assert.equal(cleared.buffers[0].loadedPath, null);
  assert.equal(cleared.running, false);
  const { buttons: [bind, clearedButton] } = renderBuffers(cleared.buffers);
  assert.equal(bind.textContent, "Bind");
  assert.equal(clearedButton.hidden, true);
  assert.equal(clearedButton.disabled, true);
});

test("embedded buffer bindings remain clearable and read-only controls stay disabled", () => {
  const embedded = [{ name: "clip", loadedPath: null, loadedFrames: 100 }];
  const { buttons: [replace, clear] } = renderBuffers(embedded);
  assert.equal(replace.textContent, "Replace");
  assert.equal(clear.hidden, false);
  assert.equal(clear.disabled, false);
  const { buttons } = renderBuffers(embedded, false);
  assert.ok(buttons.every(button => button.disabled));
});

test("the view exposes Stop during compilation and failed-compile recovery", () => {
  const panel = createRunPanel();
  for (const status of ["Compiling recovery.onda...", "Run exited"]) {
    panel.context.status = status;
    panel.evaluate(`
      runPanelState.path = "/tmp/recovery.onda";
      runPanelState.running = false;
      runPanelState.status = status;
      runProcessingRequested = true;
      postRunPanelState();
    `);
    const controls = renderTransport(JSON.parse(JSON.stringify(panel.messages.at(-1).state)));
    assert.equal(controls.stop.hidden, false);
    assert.equal(controls.stop.disabled, false);
    controls.stop.click();
    controls.stopShortcut();
    assert.deepEqual(Array.from(controls.messages, (message) => message.type), ["stop", "stop"]);
  }
});

test("the view hides Stop after cancellation and supports hosts without playback intent", () => {
  const stopped = renderTransport({ path: "/tmp/run.onda", supportsTransport: true,
    running: false, processingRequested: false });
  assert.equal(stopped.stop.hidden, true);
  assert.equal(stopped.stop.disabled, true);
  assert.equal(stopped.start.hidden, false);
  assert.equal(stopped.start.disabled, false);
  stopped.stopShortcut();
  assert.equal(stopped.messages.length, 0);

  const running = renderTransport({ path: "/tmp/run.onda", supportsTransport: true, running: true });
  assert.equal(running.stop.hidden, false);
  assert.equal(running.stop.disabled, false);
  assert.equal(running.start.hidden, true);
});

test("bundled run view exposes the Onda 0.8 log and waveform UI", () => {
  assert.match(runHtml, /id="log-output"/);
  assert.match(runHtml, /type: "clearLog"/);
  assert.match(buffersScript, /function drawBufferWaveform/);
  assert.match(runHtml, /printTransportDropCount/);
  assert.match(runHtml, /delegateTransportDropCount/);
});

test("run panel resolves every bundled script to a webview URI", () => {
  const { evaluate } = createRunPanel();
  const html = evaluate("runPanel.webview.html");
  const scripts = [...html.matchAll(/document\.write\('<script src="([^"]+)"/g)];
  assert.equal(scripts.length, 3);
  for (const [, scriptPath] of scripts) {
    assert.equal(path.isAbsolute(scriptPath), true);
    assert.equal(fs.existsSync(scriptPath), true);
  }
});

test("bundled Onda 0.8.2 run view exposes MIDI input and keyboard monitoring", () => {
  assert.match(runHtml, /id="midi-input-device"/);
  assert.match(runHtml, /id="midi-keyboard"/);
  assert.match(runHtml, /type: "setMidiInputDevice"/);
  assert.match(runHtml, /type: "midiNote"/);
  assert.match(runHtml, /COMPUTER_MIDI_KEYS/);
  assert.match(runHtml, /midiKeyboardInteractive: true/);
  assert.match(runHtml, /message\.type === "midiActivity"/);
  assert.match(runHtml, /function setMonitoredMidiNotes/);
});

test("bundled Onda 0.8.4 run view supports structured event arguments", () => {
  assert.match(runHtml, /function isStructuredEventArg/);
  assert.match(runHtml, /function structuredEventVisibleLines/);
  assert.match(runHtml, /event-structured-arg/);
  assert.match(runHtml, /JSON\.parse\(input\.value\)/);
  assert.match(runHtml, /resetEventArguments/);
});

test("a successful recompile clears the webview error across JSON serialization", async () => {
  const panel = createRunPanel();
  panel.evaluate(`
    runPanelState.path = "/tmp/recovery.onda";
    runPanelState.error = "daemon play start failed: init: unknown symbol 'Sa'";
    postRunPanelState();
  `);
  // VS Code serializes messages, and the webview merges each state update.
  const viewState = JSON.parse(JSON.stringify(panel.messages.at(-1))).state;
  assert.match(viewState.error, /unknown symbol/);

  panel.evaluate(`
    loadStoppedRunMetadata = async () => ({ params: [], output_channels: 2 });
  `);
  await panel.evaluate(`restartRunForSavedDocument({
    languageId: "onda", uri: { scheme: "file", fsPath: "/tmp/recovery.onda" },
  })`);
  Object.assign(viewState, JSON.parse(JSON.stringify(panel.messages.at(-1))).state);
  assert.equal(viewState.error, null);
  assert.equal(viewState.status, "Stopped");
  assert.equal(viewState.outputChannels, 2);
});
