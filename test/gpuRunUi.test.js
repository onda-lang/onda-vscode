const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createRunPanel } = require("./helpers/runPanel");

test("GPU state exposes MIDI selection and the configured theme", () => {
  for (const theme of ["light", "dark", "auto"]) {
    const panel = createRunPanel(undefined, { settings: { "run.theme": theme } });
    panel.evaluate("postRunPanelState()");
    const state = panel.messages.at(-1).state;
    assert.equal(state.supportsMidiInputSelection, true);
    assert.equal(state.themeMode, theme);
  }
});

test("GPU scopes target 30 Hz", () => {
  const panel = createRunPanel();
  panel.evaluate(`globalThis.intervals=[];
    setInterval=(_fn,ms)=>{intervals.push(ms);return 1;};clearInterval=()=>{};
    runPanelState.running=true;runPanelState.connected=true;runPanelReady=true;
    sendRunControlNotification=()=>{};
    scopeViewVisible=true;startScopePolling();stopScopePolling();`);
  assert.equal(panel.evaluate("intervals[0]"), 1000 / 30);
});

test("GPU host keeps playback in the embedded panel and uses the existing control transport", async () => {
  let args;
  const panel = createRunPanel(undefined, {
    modules: { child_process: { spawn(command, launch) {
      args = launch;
      return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    } } },
  });
  await panel.evaluate('runFile("/tmp/gpu.onda")');
  assert.ok(args.includes("--control-json"));
  assert.ok(args.includes("play"));
  assert.equal(panel.panelCreations.length, 1);
  const html = panel.evaluate("runPanel.webview.html");
  assert.ok(html.includes("host.js"));
  assert.ok(html.includes("wasm-unsafe-eval"));
  assert.ok(html.includes("connect-src test:"));
  assert.ok(html.includes("/out/gpu/host.js"));
});

test("GPU scope requests use the display budget and pause while hidden", async () => {
  const panel=createRunPanel(undefined);
  panel.evaluate(`globalThis.scopeRequests=[];globalThis.captureNotifications=[];runControlSocket={};runPanelState.running=true;runPanelState.connected=true;runPanelReady=true;
    sendRunControlNotification=(command,payload)=>captureNotifications.push({command,...payload});
    startScopePolling();
    sendRunControlRequest=(command,payload)=>{scopeRequests.push({command,...payload});return Promise.resolve({packet:'T1NRMQAAAAA='});};`);
  await panel.receive({type:"scopeConfig",columns:128,visible:true});
  assert.equal(panel.evaluate('scopeRequests.at(-1).columns'),128);
  assert.equal(panel.messages.at(-1).packet,'T1NRMQAAAAA=');
  const count=panel.evaluate('scopeRequests.length');
  await panel.receive({type:"scopeConfig",columns:128,visible:false});
  panel.evaluate('pollScopeData()');
  assert.equal(panel.evaluate('scopeRequests.length'),count);
  await panel.receive({type:"scopeConfig",columns:256,visible:true});
  assert.equal(panel.evaluate('scopeRequests.at(-1).columns'),256);
  const visibleCount=panel.evaluate('scopeRequests.length');
  panel.evaluate('runPanel.visible=false;pollScopeData()');
  assert.equal(panel.evaluate('scopeRequests.length'),visibleCount);
});

test("GPU restoration waits for every metadata request on the current socket", async () => {
  const socket = Object.assign(new EventEmitter(), {
    setEncoding() {}, write() {}, destroy() {},
  });
  const panel = createRunPanel(undefined, {
    modules: { net: { createConnection: () => socket } },
  });
  panel.context.socket = socket;
  panel.evaluate(`globalThis.finishEvents = undefined;
    updateRunParamSmoothing = async () => {};
    refreshRunParams = async () => {};
    refreshRunBuffers = async () => {};
    refreshRunDevices = async () => {};
    refreshRunEvents = () => new Promise(resolve => { finishEvents = resolve; });
    reapplyCachedRunParams = () => {};
    reapplyCachedRunBuffers = () => {};
    connectRunControl(1234);`);
  socket.emit("connect");
  await Promise.resolve();
  panel.evaluate("runPanelState.error = 'Device lookup failed'; postRunPanelState()");
  assert.equal(panel.messages.at(-1).state.schemaReady, false);
  panel.evaluate("finishEvents()");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.messages.at(-1).state.schemaReady, true);
  panel.evaluate("closeRunControlSocket()");
});


test("GPU scope hide/show rejects old replies without releasing a newer request", async () => {
  const panel = createRunPanel(undefined);
  panel.evaluate(`globalThis.requests=[];globalThis.notifications=[];
    runControlSocket={};runPanelState.running=true;runPanelState.connected=true;runPanelReady=true;
    sendRunControlNotification=(command,payload)=>notifications.push({command,...payload});
    sendRunControlRequest=()=>new Promise(resolve=>requests.push(resolve));
    scopeViewVisible=true;startScopePolling();pollScopeData();`);
  await panel.receive({type:"scopeConfig",columns:128,visible:false});
  await panel.receive({type:"scopeConfig",columns:128,visible:true});
  const before = panel.messages.filter(m => m.type === "scopeData").length;
  panel.evaluate(`requests[0]({packet:'old'})`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.messages.filter(m => m.type === "scopeData").length, before);
  assert.equal(panel.evaluate("scopePollingInFlight"), true);
  panel.evaluate(`requests[1]({packet:'new'})`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.messages.at(-1).packet, "new");
  panel.evaluate("runPanel.setVisible(false)");
  assert.equal(panel.evaluate("scopePollingTimer"), undefined);
  assert.equal(panel.evaluate("notifications.at(-1).value"), "off");
  panel.evaluate("runPanel.setVisible(true)");
  assert.equal(panel.evaluate("notifications.at(-1).value"), "waveform");
});

test("GPU runtime and log updates omit unchanged control banks and readiness resends them", async () => {
  const panel = createRunPanel(undefined);
  panel.evaluate(`runPanelReady=true;runPanelState.params=[{name:'gain',type:'f64',value:0.5}];postRunPanelState()`);
  panel.evaluate(`runPanelState={...runPanelState,status:'Running'};postRunPanelState()`);
  assert.deepEqual(Object.keys(panel.messages.at(-1).state), ["status"]);
  panel.evaluate(`runPanelState={...runPanelState,logText:'hello',logEntries:[{text:'hello'}]};postRunPanelState()`);
  assert.deepEqual(Object.keys(panel.messages.at(-1).state).sort(), ["logEntries", "logText"]);
  await panel.receive({type:"uiReady"});
  assert.ok(Array.isArray(panel.messages.at(-1).state.params));
});


test("GPU parameter edits send only values and do not republish metadata with the next status", () => {
  const panel = createRunPanel(undefined);
  panel.evaluate(`runPanelReady=true;runPanelState.params=[{name:'gain',type:'f64',value:0.5,default:0.25}];postRunPanelState()`);
  panel.evaluate(`applyRunParamChange('gain',0.75)`);
  const patch = panel.messages.at(-1);
  assert.equal(patch.type, "parameterValues");
  assert.deepEqual(JSON.parse(JSON.stringify(patch.state)), {params:[{name:"gain",value:0.75}]});
  panel.evaluate(`runPanelState={...runPanelState,status:'Running'};postRunPanelState()`);
  assert.deepEqual(Object.keys(panel.messages.at(-1).state), ["status"]);
});


test("GPU publications preserve consecutive explicit event resets", () => {
  const panel = createRunPanel(undefined);
  panel.evaluate(`runPanelReady=true;postRunPanelState({resetEventArguments:true})`);
  const before = panel.messages.length;
  panel.evaluate(`postRunPanelState({resetEventArguments:true})`);
  assert.equal(panel.messages.length, before + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.messages.at(-1).state)), {resetEventArguments:true});
});


test("meters and scopes share one 30 Hz publication stream", async () => {
  const panel = createRunPanel();
  panel.evaluate(`globalThis.intervals=[];globalThis.notifications=[];
    setInterval=(_fn,ms)=>{intervals.push(ms);return 1;};clearInterval=()=>{};
    runControlSocket={};runPanelState.running=true;runPanelState.connected=true;runPanelReady=true;
    sendRunControlNotification=(command,payload)=>notifications.push({command,...payload});
    sendRunControlRequest=async()=>({channels:64,peaks:Array.from({length:64},(_,i)=>i/64)});startScopePolling();`);
  await panel.receive({type:"scopeConfig",columns:128,visible:false,meter:true});
  assert.equal(panel.evaluate("intervals.at(-1)"), 1000/30);
  assert.equal(panel.evaluate("notifications.at(-1).value"), "meter");
  assert.equal(panel.messages.at(-1).type, "scopeData");
  assert.equal(panel.messages.at(-1).channels, 64);
  assert.deepEqual(Array.from(panel.messages.at(-1).peaks), Array.from({length:64},(_,i)=>i/64));
  assert.equal(panel.messages.at(-1).packet, undefined);
  assert.equal(panel.messages.at(-1).samples, undefined);
  const before = panel.messages.length;
  panel.evaluate(`sendRunControlRequest=async()=>({channels:2,peaks:[0.5,1.2],packet:'waveform'});`);
  await panel.receive({type:"scopeConfig",columns:128,visible:true,meter:true});
  assert.equal(panel.evaluate("intervals.at(-1)"), 1000/30);
  assert.equal(panel.evaluate("notifications.at(-1).value"), "waveform");
  assert.equal(panel.messages.length, before + 1);
  assert.equal(panel.messages.at(-1).packet, "waveform");
  assert.deepEqual(Array.from(panel.messages.at(-1).peaks), [0.5,1.2]);
});
