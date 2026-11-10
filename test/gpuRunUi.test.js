const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createRunPanel } = require("./helpers/runPanel");
const { createLifecyclePanel } = require("./helpers/runLifecycle");

function publishEventSchema(panel) {
  panel.evaluate(`runSchemaReady=true;
    runPanelState.events=[{name:'bang',index:0,args:[{name:'level',type:'f64',value:0.25}]}];
    postRunPanelState();`);
  return panel.messages.at(-1).state.engineGeneration;
}

test("event defaults and resets preserve scalar special float encodings", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  panel.context.defaults = ["NaN", "Infinity", "-Infinity", -0];
  panel.evaluate(`runSchemaReady=true;
    runPanelState.events=mergeRunEvents(defaults.map((value,index)=>({name:'event'+index,args:[{
      name:'value',type:'f64',shape:{kind:'scalar',encoding:'f64'},default:value
    }]})),[]);postRunPanelState()`);
  const expected = ["NaN", "Infinity", "-Infinity", "-0"];
  assert.deepEqual(Array.from(panel.messages.at(-1).state.events, event => event.args[0].value), expected);
  for (let index = 0; index < expected.length; index++) {
    const generation = panel.evaluate("String(runEngineGeneration)");
    const triggering = panel.receive({type:"triggerEvent",name:`event${index}`,values:[],engineGeneration:generation});
    const request = socket.requests.at(-1);
    assert.deepEqual(request.values, [expected[index]]);
    panel.reply(socket, request, {});
    await triggering;
  }
  panel.evaluate("runPanelState.events.forEach(event=>event.args[0].value=42)");
  await panel.receive({type:"resetEventArguments"});
  assert.deepEqual(Array.from(panel.messages.at(-1).state.events, event => event.args[0].value), expected);

  panel.evaluate(`runPanelState.events=mergeRunEvents([{name:'nested',args:[{
    name:'patch',type:'Patch',default:{values:[-0,'Infinity'],id:'9007199254740993'}
  }]}],[]);postRunPanelState()`);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.messages.at(-1).state.events[0].args[0].value)),
    {values:['-0','Infinity'],id:'9007199254740993'});
});

test("enum labels reach the GPU panel and reloads preserve only the same choices", () => {
  const panel = createRunPanel();
  const enumeration = {
    name: "Mode",
    members: [{ name: "A", label: "First" }, { name: "B", label: "Second" }],
  };
  const metadata = {
    name: "mode", type: "i32", defaultRepr: "0", rangeMinRepr: "0", rangeMaxRepr: "1",
    stepRepr: "1", stepCount: 1, enumeration,
  };
  panel.context.metadata = metadata;
  panel.evaluate(`runPanelState.params=mergeRunParams(require('./runMetadata').normalizeRunParams([metadata]), []);
    runPanelState.params[0].value=1;postRunPanelState();`);
  assert.deepEqual(panel.messages.at(-1).state.params[0].enumeration, enumeration);

  metadata.enumeration.members[1].label = "Updated";
  panel.evaluate(`runPanelState.params=mergeRunParams(require('./runMetadata').normalizeRunParams([metadata]), runPanelState.params);
    postRunPanelState();`);
  assert.equal(panel.messages.at(-1).state.params[0].value, 1);
  assert.equal(panel.messages.at(-1).state.params[0].enumeration.members[1].label, "Updated");

  metadata.enumeration.members.reverse();
  panel.evaluate(`runPanelState.params=mergeRunParams(require('./runMetadata').normalizeRunParams([metadata]), runPanelState.params);
    postRunPanelState();`);
  assert.equal(panel.messages.at(-1).state.params[0].value, 0);
});

test("theme choices persist in VS Code configuration without launching audio", async () => {
  const settings = {};
  const panel = createRunPanel(undefined, { settings });
  for (const mode of ["light", "dark"]) {
    await panel.receive({ type: "setTheme", mode });
    assert.equal(settings["run.theme"], mode);
    assert.equal(panel.messages.at(-1).state.themeMode, mode);
  }
  for (const mode of ["auto", "invalid", null, true]) {
    await panel.receive({ type: "setTheme", mode });
    assert.equal(settings["run.theme"], "dark");
  }
});

test("theme button updates an existing workspace override", async () => {
  const settings = { "run.theme": null };
  const workspaceSettings = { "run.theme": "light" };
  const panel = createRunPanel(undefined, { settings, workspaceSettings });
  await panel.receive({ type: "setTheme", mode: "dark" });
  assert.equal(panel.messages.at(-1).state.themeMode, "dark");
  assert.equal(workspaceSettings["run.theme"], "dark");
  assert.equal(settings["run.theme"], null);
});

test("GPU events from a replaced engine cannot edit or trigger the current event", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  panel.connect();
  const previousGeneration = publishEventSchema(panel);

  await panel.evaluate('runFile("/tmp/lifecycle.onda", {restart:true})');
  const socket = panel.connect();
  const generation = publishEventSchema(panel);
  const before = panel.messages.length;
  for (const engineGeneration of [previousGeneration, undefined, null, "unknown"]) {
    const stale = panel.receive({type:"triggerEvent",name:"bang",values:[0.9],engineGeneration});
    const staleRequest = socket.requests.at(-1);
    if (staleRequest) panel.reply(socket, staleRequest, {});
    await stale;
    assert.equal(socket.requests.length, 0);
    assert.equal(panel.messages.length, before);
  }

  assert.equal(typeof generation, "string");
  assert.notEqual(generation, previousGeneration);
  const current = panel.receive({type:"triggerEvent",name:"bang",values:[0.5],engineGeneration:generation});
  const request = socket.requests.at(-1);
  assert.equal(request.command, "triggerEvent");
  assert.deepEqual(request.values, [0.5]);
  panel.reply(socket, request, {});
  await current;
});

test("GPU MIDI notes stay with their originating playback engine", async t => {
  const panel = createLifecyclePanel();
  t.after(() => panel.evaluate("stopFile({silent:true})"));
  await panel.start();
  panel.connect();
  const previousGeneration = panel.evaluate("String(runEngineGeneration)");
  await panel.evaluate('runFile("/tmp/lifecycle.onda", {restart:true})');
  const socket = panel.connect();
  panel.evaluate("runPanelState.midi={available:true,noteOn:true,noteOff:true}");
  const generation = panel.evaluate("String(runEngineGeneration)");
  assert.notEqual(generation, previousGeneration);
  const send = (engineGeneration, pressed) => panel.receive({
    type: "midiNote", key: 64, velocity: pressed ? 0.5 : 0,
    pressed, engineGeneration,
  });

  for (const invalid of [previousGeneration, undefined, null, 0, "unknown"]) {
    await send(invalid, true);
    await send(invalid, false);
    assert.equal(socket.requests.length, 0);
  }
  await send(generation, true);
  assert.deepEqual(socket.requests, [{
    command: "triggerEvent", name: "note_on", values: [-1, 0, 64, 0.5],
  }]);
  await send(previousGeneration, false);
  panel.evaluate("runSchemaReady=false");
  await send(generation, false);
  assert.equal(socket.requests.length, 1);
  panel.evaluate("runSchemaReady=true");
  await send(generation, false);
  assert.deepEqual(socket.requests[1], {
    command: "triggerEvent", name: "note_off", values: [-1, 0, 64, 0],
  });
});

test("reusing an engine after an unchanged Run or canceled save keeps its events valid", async () => {
  const panel = createLifecyclePanel();
  await panel.start();
  const socket = panel.connect();
  const generation = publishEventSchema(panel);
  await panel.start();
  panel.evaluate(`vscode.window.showErrorMessage=()=>{};
    vscode.workspace.textDocuments.push({uri:vscode.Uri.file('/tmp/canceled.onda'),isDirty:true,save:async()=>false});`);
  await panel.evaluate('runFile("/tmp/canceled.onda")');
  assert.equal(panel.launches.length, 1);

  const current = panel.receive({type:"triggerEvent",name:"bang",values:[0.5],engineGeneration:generation});
  const request = socket.requests.at(-1);
  assert.equal(request.command, "triggerEvent");
  assert.deepEqual(request.values, [0.5]);
  panel.reply(socket, request, {});
  await current;
});

test("recompiled stopped schemas and replaced panels reject their earlier event commands", async () => {
  const panel = createLifecyclePanel();
  const previousGeneration = publishEventSchema(panel);
  await panel.evaluate('refreshStoppedRunMetadata("/tmp/lifecycle.onda")');
  const generation = panel.messages.at(-1).state.engineGeneration;
  assert.notEqual(generation, previousGeneration);
  let before = panel.messages.length;
  await panel.receive({type:"triggerEvent",name:"bang",values:[],engineGeneration:previousGeneration});
  assert.equal(panel.messages.length, before);

  panel.evaluate('runPanel.dispose();ensureRunPanel()');
  const currentGeneration = publishEventSchema(panel);
  before = panel.messages.length;
  await panel.receive({type:"triggerEvent",name:"bang",values:[0.9],engineGeneration:currentGeneration});
  assert.equal(panel.messages.length, before);
});

test("GPU state exposes MIDI selection and the configured theme", () => {
  for (const theme of ["light", "dark", null]) {
    const panel = createRunPanel(undefined, { settings: { "run.theme": theme } });
    panel.evaluate("postRunPanelState()");
    const state = panel.messages.at(-1).state;
    assert.equal(state.supportsMidiInputSelection, true);
    assert.equal(state.themeMode, theme);
  }
});

test("buffer picking discards results after a source reload or panel replacement", async () => {
  for (const invalidate of ["runRequestId++", "runPanelState.path='/other.onda'", "runPanel.dispose()"]) {
    const panel = createRunPanel();
    panel.evaluate(`runPanelState.path='/original.onda';
      globalThis.bindings=[];globalThis.finishPicker=undefined;
      vscode.window.showOpenDialog=()=>new Promise(resolve=>finishPicker=resolve);
      bindRunBufferFile=async(name,file)=>bindings.push({name,file});`);
    const selection = panel.evaluate("chooseRunBufferFile('clip')");
    panel.evaluate(invalidate);
    panel.evaluate("finishPicker([{fsPath:'/sample.wav'}])");
    await selection;
    assert.equal(panel.evaluate("bindings.length"), 0);
  }
  const panel = createRunPanel();
  panel.evaluate(`runPanelState.path='/current.onda';globalThis.bindings=[];
    vscode.window.showOpenDialog=async()=>[{fsPath:'/sample.wav'}];
    bindRunBufferFile=async(name,file)=>bindings.push({name,file});`);
  await panel.evaluate("chooseRunBufferFile('clip')");
  assert.equal(panel.evaluate("bindings[0].file"), "/sample.wav");
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
