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

test("run configuration changes when the audio settings, math mode, or devices change", () => {
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
  assert.equal(panel.messages.at(-1).state.blockSamples, 512);

  await panel.evaluate('runFile("/tmp/audio-settings.onda")');

  const state = panel.messages.at(-1).state;
  assert.equal(state.sampleRateHz, 96_000);
  assert.equal(state.blockSamples, 1024);
  assert.equal(launchArgs[launchArgs.indexOf("--sample-rate") + 1], "96000");
  assert.equal(launchArgs[launchArgs.indexOf("--block-size") + 1], "1024");
});

function createMathPanel() {
  const launches = [];
  const panel = createRunPanel(undefined, {
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

test(`runs default to normal math and restart when the math mode changes`, async () => {
  const panel = createMathPanel();
  await panel.evaluate('runFile("/tmp/math.onda")');
  assert.equal(panel.launches.at(-1).includes("--report-sources"), true);
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

for (const fastMath of [false, true]) {
  test(`${fastMath ? "fast" : "normal"} runs defer audio defaults to Onda`, async () => {
    const panel = createMathPanel();
    await panel.evaluate(`runFile("/tmp/defaults.onda", { fastMath: ${fastMath} })`);
    const args = panel.launches.at(-1);
    assert.equal(args.includes("--sample-rate"), false);
    assert.equal(args.includes("--block-size"), false);
    assert.equal(panel.messages.at(-1).state.sampleRateHz, 48_000);
    assert.equal(panel.messages.at(-1).state.blockSamples, 512);
  });
}

for (const [settings, expectedArgs] of [
  [{ "run.sampleRate": 48_000 }, ["--sample-rate", "48000"]],
  [{ "run.blockSize": 512 }, ["--block-size", "512"]],
  [{ "run.sampleRate": -1, "run.blockSize": 0 }, []],
]) {
  test(`only valid explicit audio overrides are passed: ${JSON.stringify(settings)}`, async () => {
    let args;
    const panel = createRunPanel(undefined, {
      settings,
      modules: { child_process: { spawn(command, launchArgs) {
        args = launchArgs;
        return Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
      } } },
    });
    await panel.evaluate('runFile("/tmp/overrides.onda")');
    const audioArgs = Array.from(args).flatMap((arg, index) =>
      ["--sample-rate", "--block-size"].includes(arg) ? [arg, args[index + 1]] : []);
    assert.deepEqual(audioArgs, expectedArgs);
  });
}

for (const outcome of ["success", "failure", "spawn error"]) {
  test(`Run never automatically reveals Output: ${outcome}`, async () => {
    let child;
    const panel = createRunPanel(undefined, {
      modules: { child_process: { spawn() {
        child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        return child;
      } } },
    });
    panel.evaluate(`
      let outputReveals = 0;
      let outputText = "";
      runOutput = {
        appendLine(text) { outputText += text + "\\n"; },
        append(text) { outputText += text; },
        show() { outputReveals += 1; },
      };
      vscode.window.showWarningMessage = () => {};
      showOndaCommandError = async () => {};
    `);
    await panel.evaluate('runFile("/tmp/output.onda")');
    child.stderr.emit("data", Buffer.from("Playing /tmp/output.onda until stopped\n"));
    assert.equal(panel.evaluate("outputReveals"), 0);
    assert.match(panel.evaluate("outputText"), /Playing/);
    if (outcome === "spawn error") {
      child.emit("error", new Error("spawn failed"));
    } else {
      child.emit("exit", outcome === "success" ? 0 : 1, null);
    }
    assert.equal(panel.evaluate("outputReveals"), 0);
    if (outcome !== "success") {
      assert.ok(panel.messages.at(-1).state.error);
    }
  });
}
