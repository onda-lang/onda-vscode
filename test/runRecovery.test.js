const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createRunPanel } = require("./helpers/runPanel");

function createRecoveryPanel() {
  const launches = [];
  const panel = createRunPanel(undefined, {
    modules: { child_process: { spawn(command, args) {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {},
      });
      launches.push({ args, child });
      return child;
    } } },
  });
  panel.evaluate(`
    vscode.window.showWarningMessage = () => {};
    showOndaCommandError = async () => {};
    connectRunControl = () => {};
  `);
  return {
    ...panel,
    launches,
    state: () => panel.messages.at(-1).state,
    save: () => panel.evaluate(`restartRunForSavedDocument({
      languageId: "onda", uri: { scheme: "file", fsPath: "/tmp/recovery.onda" },
    })`),
    ready(name) {
      launches.at(-1).child.stdout.emit("data", Buffer.from(JSON.stringify({
        event: "ready", port: 1234,
        params: [{ name, type: "f32", default: 440 }],
      }) + "\n"));
    },
    fail() {
      const child = launches.at(-1).child;
      child.stderr.emit("data", Buffer.from("unknown symbol 'Sa'"));
      child.emit("exit", 1, null);
    },
  };
}

for (const fastMath of [false, true]) {
  test(`saving a fix resumes playback and refreshes params (fast math: ${fastMath})`, async () => {
    const panel = createRecoveryPanel();
    await panel.evaluate(`runFile("/tmp/recovery.onda", { fastMath: ${fastMath} })`);
    panel.ready("old_param");
    assert.equal(panel.state().running, true);

    await panel.save();
    panel.fail();
    assert.equal(panel.state().running, false);
    assert.match(panel.state().error, /unknown symbol/);

    // Additional broken saves must retain the intention to resume as well.
    await panel.save();
    panel.fail();
    await panel.save();
    assert.equal(panel.launches.length, 4);
    assert.equal(panel.launches.at(-1).args.includes("--fast-math"), fastMath);
    panel.ready("new_param");
    assert.equal(panel.state().running, true);
    assert.equal(panel.state().error, null);
    assert.deepEqual(Array.from(panel.state().params, (param) => param.name), ["new_param"]);
  });
}

test("late events from an old process do not stop the successfully recompiled run", async () => {
  const panel = createRecoveryPanel();
  await panel.evaluate('runFile("/tmp/recovery.onda")');
  const previous = panel.launches.at(-1).child;
  await panel.save();
  panel.ready("new_param");
  previous.stdout.emit("data", Buffer.from(JSON.stringify({
    event: "ready", port: 4321, params: [{ name: "stale_param", type: "f32" }],
  }) + "\n"));
  previous.emit("exit", 1, null);
  previous.emit("error", new Error("late process error"));
  assert.equal(panel.state().running, true);
  assert.equal(panel.state().error, null);
  assert.equal(panel.evaluate("runProcess !== undefined"), true);
  assert.equal(panel.state().params[0].name, "new_param");
});

for (const action of ["stop", "clean exit"]) {
  test(`${action} prevents automatic playback on the next save`, async () => {
    const panel = createRecoveryPanel();
    await panel.evaluate('runFile("/tmp/recovery.onda")');
    if (action === "stop") {
      panel.fail();
      await panel.evaluate("stopFile({ silent: true })");
    } else {
      panel.launches.at(-1).child.emit("exit", 0, null);
      assert.equal(panel.state().error, null);
    }
    panel.evaluate(`loadStoppedRunMetadata = async () => ({
      params: [{ name: "updated_param", type: "f32", default: 440 }],
    })`);
    await panel.save();
    assert.equal(panel.launches.length, 1);
    assert.equal(panel.state().running, false);
    assert.equal(panel.state().error, null);
    assert.equal(panel.state().params[0].name, "updated_param");
  });
}

test("compile failures use a short status message that clears when saving a fix", async () => {
  const panel = createRecoveryPanel();
  panel.evaluate('vscode.window.showWarningMessage = () => { throw new Error("Unexpected warning toast"); }');
  await panel.evaluate('runFile("/tmp/recovery.onda")');
  panel.fail();

  const message = panel.statusMessages.at(-1);
  assert.equal(message.timeout, 5000);
  assert.match(message.text, /recovery\.onda/);
  assert.equal(message.disposed, false);
  assert.match(panel.state().error, /unknown symbol/);

  await panel.save();
  assert.equal(message.disposed, true);
  panel.ready("fixed_param");
  assert.equal(panel.state().error, null);
  assert.equal(panel.statusMessages.length, 1);
});

test("Stop dismisses the failure status and clean exits do not show one", async () => {
  const panel = createRecoveryPanel();
  await panel.evaluate('runFile("/tmp/recovery.onda")');
  panel.fail();
  const message = panel.statusMessages.at(-1);
  await panel.receive({ type: "stop" });
  assert.equal(message.disposed, true);

  await panel.evaluate('runFile("/tmp/recovery.onda")');
  panel.launches.at(-1).child.emit("exit", 0, null);
  assert.equal(panel.statusMessages.length, 1);
});
