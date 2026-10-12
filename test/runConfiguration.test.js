const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createRunPanel } = require("./helpers/runPanel");

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

test("run panel and Onda process use the configured audio settings", async () => {
  let launchArgs;
  const panel = createRunPanel(undefined, {
    settings: { "run.sampleRate": 96_000, "run.blockSize": 1024 },
    modules: {
      child_process: { spawn(command, args) {
        launchArgs = args;
        return Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
      } },
    },
  });
  assert.equal(panel.messages.at(-1).state.blockSamples, 256);

  await panel.evaluate('runFile("/tmp/audio-settings.onda")');

  const state = panel.messages.at(-1).state;
  assert.equal(state.sampleRateHz, 96_000);
  assert.equal(state.blockSamples, 1024);
  assert.equal(launchArgs[launchArgs.indexOf("--sample-rate") + 1], "96000");
  assert.equal(launchArgs[launchArgs.indexOf("--block-size") + 1], "1024");
});
