const assert = require("node:assert/strict");
const test = require("node:test");
const { createLifecyclePanel } = require("./helpers/runLifecycle");

const settle = () => new Promise(resolve => setImmediate(resolve));

for (const failure of ["closed", "reset"]) {
  test(`a control connection ${failure} stops playback and lets Run retry with cached controls`, async t => {
    const panel = createLifecyclePanel();
    t.after(() => panel.evaluate("stopFile({silent:true})"));
    await panel.start();
    const child = panel.launches[0].child;
    const socket = panel.connect();
    panel.evaluate(`runPanelState.params=[{name:'wide',type:'i64',value:'9007199254740993'}];
      runPanelState.events=[{name:'bang',args:[]}];
      runPanelState.buffers=[{name:'clip',loadedPath:'/tmp/clip.wav'}];
      preservedRunBufferBindings.set('clip','/tmp/clip.wav');`);
    const pending = assert.rejects(panel.evaluate('sendRunControlRequest("getParams")'), /session ended|connection closed/i);

    if (failure === "reset") socket.emit("error", new Error("read ECONNRESET"));
    socket.destroy();
    await pending;
    await settle();

    assert.equal(child.killed, true);
    assert.equal(panel.evaluate("runProcess"), undefined);
    assert.equal(panel.evaluate("pendingRunRequests.size"), 0);
    assert.equal(panel.state().running, false);
    assert.equal(panel.state().connected, false);
    assert.equal(panel.state().processingRequested, false);
    assert.equal(panel.state().path, "/tmp/lifecycle.onda");
    assert.match(panel.state().error, /control connection/i);
    assert.match(panel.state().error, /run again/i);
    if (failure === "reset") assert.match(panel.state().error, /ECONNRESET/);
    assert.equal(panel.state().params[0].value, "9007199254740993");
    assert.equal(panel.state().events[0].name, "bang");
    assert.equal(panel.evaluate("preservedRunBufferBindings.get('clip')"), "/tmp/clip.wav");

    // The old process can finish after the failure was reported.
    child.emit("exit", null, "SIGTERM");
    assert.match(panel.state().error, /control connection/i);
    await panel.receive({ type: "start" });
    assert.equal(panel.launches.length, 2);
    assert.equal(panel.state().error, null);
    assert.equal(panel.state().params[0].value, "9007199254740993");
  });
}

test("expected and obsolete control socket closures do not fail a replacement run", async t => {
  const panel = createLifecyclePanel();
  t.after(() => panel.evaluate("stopFile({silent:true})"));
  await panel.start();
  const socket = panel.connect();
  await panel.evaluate('runFile("/tmp/new.onda")');
  assert.equal(socket.destroyed, true);
  assert.equal(panel.state().error, null);
  const child = panel.launches.at(-1).child;
  panel.connect();

  socket.emit("error", new Error("late ECONNRESET"));
  socket.emit("close");
  assert.equal(panel.evaluate("runProcess !== undefined"), true);
  assert.equal(child.killed, undefined);
  assert.equal(panel.evaluate("runPanelState.connected"), true);
  assert.equal(panel.state().error, null);

  await panel.evaluate("stopFile({silent:true})");
  assert.equal(panel.state().error, null);
});

test("a control disconnect does not cancel a newer Run waiting for its input", async t => {
  const panel = createLifecyclePanel();
  t.after(() => panel.evaluate("stopFile({silent:true})"));
  await panel.start();
  const socket = panel.connect();
  panel.evaluate(`let finishInput;
    resolveRunPath=()=>new Promise(resolve=>{finishInput=resolve});`);
  const starting = panel.evaluate('runFile("/tmp/new.onda")');
  socket.destroy();
  await settle();
  panel.evaluate("finishInput({fsPath:'/tmp/new.onda',saved:false})");
  await starting;

  assert.equal(panel.launches.length, 2);
  assert.equal(panel.state().path, "/tmp/new.onda");
  assert.equal(panel.state().error, null);
});
