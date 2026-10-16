const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRunPanel } = require("./helpers/runPanel");

const runHtml = fs.readFileSync(
  path.join(__dirname, "..", "ui", "run", "run.html"),
  "utf8",
);
const buffersScript = fs.readFileSync(
  path.join(__dirname, "..", "ui", "run", "buffers.js"),
  "utf8",
);

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
