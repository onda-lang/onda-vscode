const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sameRunProcessConfiguration,
} = require("../out/runConfiguration.js");

const configuration = {
  sampleRateHz: 48_000,
  blockFrames: 256,
  inputDevice: null,
  outputDevice: "Speakers",
  midiInputDevice: "Computer Keyboard",
};

test("run configuration equality requires an active matching process", () => {
  assert.equal(sameRunProcessConfiguration(undefined, configuration), false);
  assert.equal(sameRunProcessConfiguration({ ...configuration }, configuration), true);
});

test("run configuration changes when any process-bound device changes", () => {
  for (const update of [
    { inputDevice: "Microphone" },
    { outputDevice: "Headphones" },
    { midiInputDevice: "MIDI Controller" },
  ]) {
    assert.equal(
      sameRunProcessConfiguration({ ...configuration, ...update }, configuration),
      false,
    );
  }
});
