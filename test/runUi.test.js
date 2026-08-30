const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const runHtml = fs.readFileSync(
  path.join(__dirname, "..", "ui", "run", "run.html"),
  "utf8",
);

test("bundled run view exposes the Onda 0.8 log and waveform UI", () => {
  assert.match(runHtml, /id="log-output"/);
  assert.match(runHtml, /type: "clearLog"/);
  assert.match(runHtml, /function drawBufferWaveform/);
  assert.match(runHtml, /printTransportDropCount/);
  assert.match(runHtml, /delegateTransportDropCount/);
});
