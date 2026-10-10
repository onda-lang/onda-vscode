const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createRunPanel } = require("./helpers/runPanel");

function createSmoothingPanel(options) {
  const socket = new EventEmitter();
  const requests = [];
  socket.destroyed = false;
  socket.setEncoding = () => {};
  socket.destroy = () => { socket.destroyed = true; socket.emit("close"); };
  socket.write = (line, callback) => {
    requests.push(JSON.parse(line));
    callback?.();
  };
  const launches = [];
  const panel = createRunPanel(undefined, {
    ...options,
    modules: {
      net: { createConnection: () => socket },
      child_process: { spawn(command, args) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        launches.push({ command, args, child });
        return child;
      } },
    },
  });
  panel.context.socket = socket;
  return {
    ...panel, socket, requests, launches,
    state: () => panel.messages.at(-1).state,
    connect() {
      panel.evaluate("runControlSocket = socket; runPanelState.connected = true;");
    },
    set: milliseconds => panel.receive({ type: "setParamSmoothing", milliseconds }),
    reply(request, error) {
      panel.context.reply = JSON.stringify({ id: request.id, ok: !error, error });
      panel.evaluate("handleRunControlLine(reply)");
    },
  };
}

test("Smooth starts at 30 ms and offline edits preserve its reset target", async () => {
  const panel = createSmoothingPanel();
  assert.equal(panel.state().supportsParamSmoothing, true);
  assert.equal(panel.state().paramSmoothingMs, 30);
  await panel.set(12.5);
  assert.equal(panel.state().paramSmoothingMs, 12.5);
  assert.equal(panel.state().paramSmoothingDefaultMs, 30);
  assert.equal(panel.requests.length, 0);
});

test("Smooth sends seconds, accepts zero, and resets to the launch default", async () => {
  const panel = createSmoothingPanel();
  panel.connect();
  for (const milliseconds of [12.5, 0, 30]) {
    const update = panel.set(milliseconds);
    const request = panel.requests.at(-1);
    assert.equal(request.command, "setParamSmoothing");
    assert.equal(request.value, milliseconds / 1000);
    panel.reply(request);
    await update;
    assert.equal(panel.state().paramSmoothingMs, milliseconds);
    assert.equal(panel.state().paramSmoothingDefaultMs, 30);
  }
});

test("invalid smoothing messages do not reach Onda or alter the value", async () => {
  const panel = createSmoothingPanel();
  panel.connect();
  for (const value of [-1, NaN, Infinity, "30", null, undefined]) {
    await panel.set(value);
    assert.equal(panel.state().paramSmoothingMs, 30);
  }
  assert.equal(panel.requests.length, 0);
});

test("excessive offline smoothing retains the previous duration for the next launch", async () => {
  const panel = createSmoothingPanel();
  await panel.set(12.5);
  await panel.set(1e20);
  assert.equal(panel.state().paramSmoothingMs, 12.5);
  assert.match(panel.state().error, /sample counter/);
  assert.equal(panel.requests.length, 0);
  await panel.evaluate('runFile("/tmp/first.onda")');
  const { args } = panel.launches.at(-1);
  assert.equal(args[args.indexOf("--param-smoothing-ms") + 1], "12.5");
  assert.equal(panel.state().error, undefined);
});

test("smoothing rejects the sample-counter boundary offline and live", async () => {
  const panel = createSmoothingPanel({ settings: { "run.sampleRate": 1000 } });
  const counterLimit = process.arch === "ia32" || process.arch === "arm"
    ? 2 ** 32 - 1 : 2 ** 64;
  await panel.set(counterLimit / 2);
  assert.equal(panel.state().paramSmoothingMs, counterLimit / 2);
  for (const connected of [false, true]) {
    if (connected) panel.connect();
    for (const value of [counterLimit, 1e20, Number.MAX_VALUE]) {
      await panel.set(value);
      assert.equal(panel.state().paramSmoothingMs, counterLimit / 2);
      assert.match(panel.state().error, /sample counter/);
    }
  }
  assert.equal(panel.requests.length, 0);
  const reset = panel.set(30);
  panel.reply(panel.requests.at(-1));
  await reset;
  assert.equal(panel.state().paramSmoothingMs, 30);
  assert.equal(panel.state().error, undefined);
});

test("offline smoothing uses the configured sample rate, live smoothing uses the launch rate", async () => {
  const settings = { "run.sampleRate": 48_000 };
  const panel = createSmoothingPanel({ settings });
  const counterLimit = process.arch === "ia32" || process.arch === "arm"
    ? 2 ** 32 - 1 : 2 ** 64;
  const milliseconds = counterLimit / 72_000 * 1000;
  await panel.evaluate('runFile("/tmp/first.onda")');
  panel.connect();
  settings["run.sampleRate"] = 96_000;
  const update = panel.set(milliseconds);
  const request = panel.requests.at(-1);
  assert.equal(request.value, milliseconds / 1000);
  panel.reply(request);
  await update;
  assert.equal(panel.state().paramSmoothingMs, milliseconds);
  panel.evaluate("closeRunControlSocket(); runProcess = undefined; runPanelState.connected = false;");
  await panel.set(12.5);
  await panel.set(milliseconds);
  assert.equal(panel.state().paramSmoothingMs, 12.5);
  assert.match(panel.state().error, /sample counter/);
});

test("failed smoothing updates restore the last accepted duration", async () => {
  const panel = createSmoothingPanel();
  panel.connect();
  const first = panel.set(45);
  const second = panel.set(60);
  panel.reply(panel.requests[0]);
  await first;
  panel.reply(panel.requests[1], "duration exceeds the host sample counter");
  await second;
  assert.equal(panel.state().paramSmoothingMs, 45);
  assert.match(panel.state().error, /sample counter/);
  const reset = panel.set(30);
  panel.reply(panel.requests.at(-1));
  await reset;
  assert.equal(panel.state().paramSmoothingMs, 30);
  assert.equal(panel.state().error, undefined);
});

test("late replies cannot overwrite newer drag updates", async () => {
  const panel = createSmoothingPanel();
  panel.connect();
  const first = panel.set(45);
  const second = panel.set(60);
  panel.reply(panel.requests[1]);
  await second;
  panel.reply(panel.requests[0], "obsolete failure");
  await first;
  assert.equal(panel.state().paramSmoothingMs, 60);
  assert.equal(panel.state().error, undefined);
});

test("replies from an ended run do not change the replacement run", async () => {
  const panel = createSmoothingPanel();
  panel.connect();
  const update = panel.set(60);
  panel.evaluate("closeRunControlSocket(); runPanelState.connected = false;");
  await panel.set(15);
  await update;
  assert.equal(panel.state().paramSmoothingMs, 15);
  assert.equal(panel.state().error, undefined);
});

test("restarts and file changes launch Onda with the retained smoothing duration", async () => {
  const panel = createSmoothingPanel();
  await panel.set(12.5);
  for (const call of [
    'runFile("/tmp/first.onda")',
    'runFile("/tmp/first.onda", { restart: true })',
    'runFile("/tmp/second.onda")',
  ]) {
    await panel.evaluate(call);
    const { args } = panel.launches.at(-1);
    assert.equal(args[args.indexOf("--param-smoothing-ms") + 1], "12.5");
    assert.equal(panel.state().paramSmoothingMs, 12.5);
    assert.equal(panel.state().paramSmoothingDefaultMs, 30);
  }
  assert.equal(panel.launches.length, 3);
});

test("connection applies edits made while the engine was starting", async () => {
  const panel = createSmoothingPanel();
  await panel.set(12.5);
  panel.evaluate("connectRunControl(1234)");
  await panel.set(25);
  panel.socket.emit("connect");
  const request = panel.requests.find(request => request.command === "setParamSmoothing");
  assert.equal(request.value, 0.025);
  for (const request of panel.requests) {
    if (request.id) panel.reply(request);
  }
  // Let the request completions publish their state.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.state().paramSmoothingMs, 25);
});

test("a rejected startup edit restores the duration passed at launch", async () => {
  const panel = createSmoothingPanel();
  await panel.set(12.5);
  await panel.evaluate('runFile("/tmp/first.onda")');
  await panel.set(25);
  panel.connect();
  const update = panel.set(25);
  panel.reply(panel.requests.at(-1), "startup smoothing update rejected");
  await update;
  assert.equal(panel.state().paramSmoothingMs, 12.5);
});
