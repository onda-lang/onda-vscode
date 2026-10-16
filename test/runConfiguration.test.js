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
  fastMath: false,
  inputDevice: null,
  outputDevice: "Speakers",
  midiInputDevice: "Computer Keyboard",
};

test("run configuration equality requires an active matching process", () => {
  assert.equal(sameRunProcessConfiguration(undefined, configuration), false);
  assert.equal(sameRunProcessConfiguration({ ...configuration }, configuration), true);
});

test("run configuration changes when audio settings, math mode, or devices change", () => {
  for (const update of [
    { sampleRateHz: 96_000 },
    { blockFrames: 512 },
    { fastMath: true },
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

function createMathPanel(host = "webview") {
  const launches = [];
  const panel = createRunPanel(undefined, {
    settings: { "run.host": host },
    modules: {
      child_process: { spawn(command, args) {
        launches.push(args);
        return Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {},
        });
      } },
    },
  });
  return { ...panel, launches };
}

for (const host of ["webview", "egui"]) {
  test(`${host} runs default to normal math and restart when the math mode changes`, async () => {
    const panel = createMathPanel(host);
    await panel.evaluate('runFile("/tmp/math.onda")');
    assert.equal(panel.launches.at(-1).includes("--fast-math"), false);
    assert.equal(panel.evaluate("runPanelState.fastMath"), false);

    await panel.evaluate('runFile("/tmp/math.onda", { fastMath: true })');
    assert.equal(panel.launches.length, 2);
    assert.equal(panel.launches.at(-1).includes("--fast-math"), true);
    assert.equal(panel.evaluate("runPanelState.fastMath"), true);

    await panel.evaluate('runFile("/tmp/math.onda", { fastMath: true })');
    assert.equal(panel.launches.length, 2);

    await panel.evaluate('runFile("/tmp/math.onda")');
    assert.equal(panel.launches.length, 3);
    assert.equal(panel.launches.at(-1).includes("--fast-math"), false);
    assert.equal(panel.evaluate("runPanelState.fastMath"), false);
  });
}

test("source saves and device changes preserve the session's fast math mode", async () => {
  const panel = createMathPanel();
  await panel.evaluate('runFile("/tmp/math.onda", { fastMath: true })');
  await panel.evaluate(`restartRunForSavedDocument({
    languageId: "onda", uri: { scheme: "file", fsPath: "/tmp/math.onda" },
  })`);
  assert.equal(panel.launches.length, 2);
  assert.equal(panel.launches.at(-1).includes("--fast-math"), true);

  panel.evaluate("runPanelState.running = true");
  await panel.receive({ type: "setOutputDevice", name: "Headphones" });
  assert.equal(panel.launches.length, 3);
  assert.equal(panel.launches.at(-1).includes("--fast-math"), true);
  assert.equal(panel.messages.at(-1).state.fastMath, true);
});

test("panel Play keeps fast math after stopping, and regular Run clears it", async () => {
  const panel = createMathPanel();
  await panel.evaluate('runFile("/tmp/math.onda", { fastMath: true })');
  await panel.evaluate("stopFile({ silent: true })");
  await panel.receive({ type: "start" });
  assert.equal(panel.launches.length, 2);
  assert.equal(panel.launches.at(-1).includes("--fast-math"), true);

  await panel.evaluate("stopFile({ silent: true })");
  await panel.evaluate('runFile("/tmp/math.onda")');
  assert.equal(panel.launches.at(-1).includes("--fast-math"), false);
  assert.equal(panel.messages.at(-1).state.fastMath, false);
});

test("running another source does not inherit fast math", async () => {
  const panel = createMathPanel();
  await panel.evaluate('runFile("/tmp/math.onda", { fastMath: true })');
  await panel.evaluate('runFile("/tmp/other.onda")');
  assert.equal(panel.launches.at(-1).includes("--fast-math"), false);
  assert.equal(panel.messages.at(-1).state.fastMath, false);
});
