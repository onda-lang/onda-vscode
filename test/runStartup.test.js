const assert = require("node:assert/strict");
const test = require("node:test");
const { createLifecyclePanel } = require("./helpers/runLifecycle");

const settle = () => new Promise(resolve => setImmediate(resolve));

async function startup(t) {
  const panel = createLifecyclePanel();
  t.after(() => panel.evaluate("stopFile({silent:true})"));
  await panel.start();
  const socket = panel.connect();
  panel.evaluate(`runSchemaReady=false;
    updateRunParamSmoothing=async()=>{};
    refreshRunParams=async()=>{};
    refreshRunBuffers=async()=>{};
    refreshRunEvents=async()=>{};
    refreshRunDevices=async()=>{};
    runPanelState.params=[{name:'gain',value:0.75}];
    runPanelState.buffers=[{name:'clip'}];
    preservedRunBufferBindings.set('clip','/tmp/restored.wav');`);
  socket.emit("connect");
  await settle();
  return { panel, socket };
}

test("startup waits for parameter and buffer acknowledgements before playing", async t => {
  const { panel, socket } = await startup(t);
  assert.ok(panel.launches[0].args.includes("--start-paused"));
  const parameter = socket.requests.find(request => request.command === "setParam");
  assert.equal(typeof parameter.id, "number");
  assert.equal(socket.requests.some(request => request.command === "play"), false);
  panel.reply(socket, parameter, {});
  await settle();
  const buffer = socket.requests.find(request => request.command === "bindBufferWav");
  assert.ok(buffer);
  assert.equal(panel.evaluate("runSchemaReady"), false);
  assert.equal(socket.requests.some(request => request.command === "play"), false);
  panel.reply(socket, buffer, {});
  await settle();
  const play = socket.requests.at(-1);
  assert.equal(play.command, "play");
  panel.reply(socket, play, {});
  await settle();
  assert.equal(panel.evaluate("runSchemaReady"), true);
});

test("Stop during restoration prevents automatic playback", async t => {
  const { panel, socket } = await startup(t);
  const pausing = panel.receive({ type: "stop" });
  panel.reply(socket, socket.requests.at(-1), {});
  await pausing;
  panel.reply(socket, socket.requests.find(request => request.command === "setParam"), {});
  await settle();
  panel.reply(socket, socket.requests.find(request => request.command === "bindBufferWav"), {});
  await settle();
  assert.equal(socket.requests.some(request => request.command === "play"), false);
  assert.equal(panel.evaluate("runProcessingRequested"), false);
});

test("Play during restoration retains intent without starting DSP early", async t => {
  const { panel, socket } = await startup(t);
  panel.evaluate("runProcessingRequested=false");
  await panel.evaluate("setRunProcessing(true)");
  assert.equal(socket.requests.some(request => request.command === "play"), false);
  assert.equal(panel.evaluate("runProcessingRequested"), true);
});

for (const command of ["setParam", "bindBufferWav"]) {
  test(`a failed ${command} restoration leaves playback stopped`, async t => {
    const { panel, socket } = await startup(t);
    const parameter = socket.requests.find(request => request.command === "setParam");
    panel.reply(socket, parameter, {}, command === "setParam" ? "Restore failed" : undefined);
    await settle();
    if (command === "bindBufferWav") {
      panel.reply(socket, socket.requests.find(request => request.command === command), {}, "Restore failed");
      await settle();
    }
    assert.equal(socket.requests.some(request => request.command === "play"), false);
    assert.equal(panel.evaluate("runProcessingRequested"), false);
    assert.equal(panel.evaluate("runProcess"), undefined);
    assert.match(panel.state().error, /Restore failed/);
  });
}

test("a buffer edit during restoration is applied before playback", async t => {
  const { panel, socket } = await startup(t);
  panel.reply(socket, socket.requests.find(request => request.command === "setParam"), {});
  await settle();
  const buffer = socket.requests.at(-1);
  assert.equal(buffer.command, "bindBufferWav");
  await panel.receive({ type: "clearBuffer", name: "clip" });
  panel.reply(socket, buffer, {});
  await settle();
  const clear = socket.requests.at(-1);
  assert.equal(clear.command, "clearBuffer");
  assert.equal(socket.requests.some(request => request.command === "play"), false);
  panel.reply(socket, clear, {});
  await settle();
  const play = socket.requests.at(-1);
  assert.equal(play.command, "play");
  panel.reply(socket, play, {});
});

test("a replacement session cannot be played by old restoration replies", async t => {
  const { panel, socket } = await startup(t);
  panel.reply(socket, socket.requests.find(request => request.command === "setParam"), {});
  await settle();
  const buffer = socket.requests.at(-1);
  await panel.evaluate("runFile('/tmp/new.onda')");
  const replacement = panel.connect();
  panel.reply(socket, buffer, {});
  await settle();
  assert.equal(replacement.requests.some(request => request.command === "play"), false);
  assert.equal(panel.state().path, "/tmp/new.onda");
});
