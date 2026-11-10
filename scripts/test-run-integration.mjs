import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRunPanel } from '../test/helpers/runPanel.js';
import { compilerTargets, compilerVersion, extensionRoot, verifyCompilerBundle } from './compiler-bundle.mjs';

const root = extensionRoot;
const selectedCompiler = process.argv[2] || 'bundled';
const bundled = selectedCompiler === 'bundled';
const manifest = bundled ? verifyCompilerBundle(root, `${process.platform}-${process.arch}`) : undefined;
const command = bundled
  ? join(root, 'compiler', manifest.target, 'bin', compilerTargets[manifest.target].executable)
  : resolve(selectedCompiler);
const version = childProcess.spawnSync(command, ['--version'], {encoding:'utf8'});
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), `Onda ${compilerVersion}`);
console.log(`Integration compiler: ${command} (${version.stdout.trim()}${manifest ? `, ${manifest.sha256}` : ''})`);
const settings = bundled ? {'compiler.source':'bundled','exec.args':[]}
  : {'compiler.source':'external','exec.path':command,'exec.args':[]};
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'onda-run-integration-')));
const source = join(workspace, 'café.onda');
const text = `enum Mode:
  LowPass
  HighPass {label = "High-pass"}
struct Patch:
  id: i64 = 9007199254740993
  mode: Mode = Mode::HighPass
  levels: f32[2]
  pair: (i32, bool)
params:
  wide: i64 = 9007199254740993
  modes: Mode[2] = [Mode::LowPass, Mode::HighPass]
  count: i32 = 2 {0, 10}
buffers:
  clip: f32
delegate exact(value: i64)
delegate report(value: f64)
delegate report32(value: f32)
delegate echoed(patch: Patch)
event inspect():
  exact(wide)
event configure(patches: Patch[]):
  if patches.len() > 0:
    echoed(patches[0])
event positive(value: f64 = 1.0 / 0.0):
  report(value)
event invalid(value: f64 = 0.0 / 0.0):
  report(value)
event negative_zero(value: f64 = -0.0):
  report(value)
event negative_zero32(value: f32 = -0.0):
  report32(value)
sample:
  out1 = 0.0
`;
await writeFile(source, text);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
function panelOptions(modules) {
  return {settings, extensionDirectory:root, modules};
}
async function dispose(panel) {
  await panel.evaluate('stopFile({silent:true});disposeRunFileWatcher()');
}

try {
  await test('LSP recovers when a missing include is created before dependency discovery finishes', {timeout:30000}, async t => {
    const entry = join(workspace, 'language.onda');
    const dependency = join(workspace, 'new', 'nested', 'created.on');
    const text = 'include "new/nested/created.on"\nsample:\n  out1 = dependency(0.0)\n';
    await writeFile(entry, text);
    const child = childProcess.spawn(command, ['lsp'], {stdio:'pipe'});
    t.after(() => child.kill());
    let buffer = Buffer.alloc(0);
    let parseError;
    const messages = [];
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const length = Number(/content-length:\s*(\d+)/i.exec(buffer.toString('ascii', 0, end))[1]);
          if (buffer.length < end + 4 + length) return;
          messages.push(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()));
          buffer = buffer.subarray(end + 4 + length);
        }
      } catch (error) { parseError = error; }
    });
    const send = message => {
      const body = JSON.stringify({jsonrpc:'2.0', ...message});
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    send({id:1, method:'initialize', params:{processId:process.pid, rootUri:null, capabilities:{}}});
    await until(() => messages.some(message => message.id === 1), 'LSP initialization');
    send({method:'initialized', params:{}});
    const uri = pathToFileURL(entry).href;
    send({method:'textDocument/didOpen', params:{textDocument:{uri, languageId:'onda', version:1, text}}});
    const diagnostics = () => messages.filter(message => message.method === 'textDocument/publishDiagnostics'
      && message.params.uri === uri).at(-1)?.params.diagnostics;
    await until(() => diagnostics()?.some(item => item.message.includes('failed to resolve include')), 'missing include diagnostic');

    const panel = createRunPanel('0.9.0', panelOptions());
    t.after(() => dispose(panel));
    const { LanguageDependencies } = createRequire(join(root, 'out', 'extension.js'))('./languageDependencies');
    let releaseDiscovery;
    const gate = new Promise(resolve => { releaseDiscovery = resolve; });
    let discoveries = 0;
    const watcher = new LanguageDependencies(async (file, signal) => {
      discoveries++;
      await gate;
      panel.context.entry = file;
      panel.context.signal = signal;
      return panel.evaluate('withOndaDaemon(entry,signal,request=>request("run_sources",{path:entry}))');
    }, files => send({method:'workspace/didChangeWatchedFiles', params:{
      changes:files.map(file => ({uri:pathToFileURL(file).href, type:2})),
    }}), assert.fail);
    t.after(() => watcher.dispose());
    const discovering = watcher.open(entry);
    // Force the registration gap while retaining real daemon and LSP exchanges.
    await mkdir(join(workspace, 'new', 'nested'), {recursive:true});
    await writeFile(dependency, 'def dependency(x):\n  return x\n');
    releaseDiscovery();
    await discovering;
    await until(() => diagnostics()?.length === 0, 'diagnostic recovery after discovery');
    assert.equal(discoveries, 1, 'Revalidation must not start a discovery loop');
    assert.ifError(parseError);
    send({id:2, method:'shutdown', params:null});
    await until(() => messages.some(message => message.id === 2), 'LSP shutdown');
    const closed = once(child, 'close');
    send({method:'exit', params:null});
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0);
  });

  await test('MIDI commands cannot cross a real playback engine replacement', {timeout:30000}, async t => {
    const file = join(workspace, 'midi-generation.onda');
    await writeFile(file, `init:
  presses = 0
  releases = 0
  level = 0.0
delegate snapshot(presses: i32, releases: i32, level: f32)
event note_on(id: i32, channel: i32, key: i32, velocity: f32):
  presses += 1
  level = velocity
event note_off(id: i32, channel: i32, key: i32, velocity: f32):
  releases += 1
  level = 0.0
event cc(channel: i32, index: i32, value: f32) {}
event inspect():
  snapshot(presses, releases, level)
sample:
  out1 = 0.0
`);
    const panel = createRunPanel('0.9.0', panelOptions());
    t.after(() => dispose(panel));
    panel.context.source = file;
    await panel.evaluate('runFile(source)');
    const ready = () => panel.evaluate('runPanelState.connected && runSchemaReady');
    await until(ready, 'initial MIDI playback');
    const previousGeneration = panel.evaluate('String(runEngineGeneration)');
    await panel.evaluate('runFile(source,{restart:true})');
    await until(ready, 'replacement MIDI playback');
    await until(() => panel.evaluate('pendingRunRequests.size===0'), 'MIDI playback initialization');
    assert.equal(panel.evaluate('runPanelState.midi.noteOn && runPanelState.midi.noteOff'), true);
    const generation = panel.evaluate('String(runEngineGeneration)');
    assert.notEqual(generation, previousGeneration);
    const send = (engineGeneration, pressed) => panel.receive({
      type:'midiNote', key:60, velocity:pressed ? 0.5 : 0, pressed, engineGeneration,
    });
    const snapshot = async () => {
      // MIDI executes at sample offsets; acknowledge a later MIDI event first.
      await panel.evaluate("sendRunControlRequest('triggerEvent',{name:'cc',values:[0,0,0]})");
      await panel.receive({type:'clearLog'});
      await panel.receive({type:'triggerEvent',name:'inspect',values:[],engineGeneration:generation});
      await until(() => panel.evaluate('runPanelState.logEntries.some(entry=>entry?.delegate?.name==="snapshot")'), 'MIDI state');
      return JSON.parse(JSON.stringify(panel.evaluate('runPanelState.logEntries.find(entry=>entry?.delegate?.name==="snapshot").delegate.values')));
    };
    await send(previousGeneration, true);
    await send(generation, true);
    await send(previousGeneration, false);
    assert.deepEqual(await snapshot(), {presses:1,releases:0,level:0.5});
    await send(generation, false);
    assert.deepEqual(await snapshot(), {presses:1,releases:1,level:0});
  });

  for (const clear of [false, true]) {
    await test(`reload preserves a pending buffer ${clear ? 'clear' : 'selection'} before initialization`, {timeout:30000}, async t => {
      const file = join(workspace, 'pending-buffer.onda');
      const wav = join(workspace, 'pending-buffer.wav');
      await writeFile(file, 'buffers:\n  clip: f32\ninit:\n  value = clip[0]\ndelegate report(value: f32)\nevent inspect():\n  report(value)\nsample:\n  out1 = 0.0\n');
      const bytes = Buffer.alloc(48);
      bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVEfmt ',8);
      bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(1,22);
      bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(32,34);
      bytes.write('data',36);bytes.writeUInt32LE(4,40);bytes.writeFloatLE(0.5,44);
      await writeFile(wav, bytes);
      const panel = createRunPanel('0.9.0', panelOptions());
      t.after(() => dispose(panel));
      panel.context.source = file;
      await panel.evaluate('runFile(source)');
      await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'initial playback');
      if (clear) await panel.receive({type:'bindBufferFile', name:'clip', filePath:wav});
      const editing = panel.receive(clear ? {type:'clearBuffer', name:'clip'}
        : {type:'bindBufferFile', name:'clip', filePath:wav});
      assert.ok(panel.evaluate('pendingRunRequests.size') > 0);
      await panel.evaluate('runFile(source,{restart:true})');
      await editing;
      await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'replacement playback');
      assert.equal(panel.evaluate('runPanelState.buffers[0].loadedPath'), clear ? null : wav);
      await panel.receive({type:'triggerEvent', name:'inspect', values:[], engineGeneration:panel.evaluate('String(runEngineGeneration)')});
      await until(() => panel.evaluate('runPanelState.logEntries.some(entry=>entry?.delegate?.name==="report")'), 'initialized buffer value');
      assert.equal(panel.evaluate('runPanelState.logEntries.find(entry=>entry?.delegate?.name==="report").delegate.values.value'), clear ? 0 : 0.5);
    });
  }

  await test('project-name validation agrees with the real compiler on reserved Windows names', {timeout:30000}, async () => {
    const panel = createRunPanel('0.9.0', panelOptions());
    panel.context.Buffer = Buffer;
    for (const [accepted, names] of [
      [true, ['project', 'conin', 'conout', 'COM0', 'COM10', 'LPT0', 'LPT10', 'COM¹-extra']],
      [false, ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'CONIN$', 'CONOUT$',
        'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³', 'conin$.project', 'com².project']],
    ]) {
      for (const name of names) {
        panel.context.projectName = name;
        assert.equal(panel.evaluate('validateProjectName(projectName)') === undefined, accepted, name);
        const result = childProcess.spawnSync(command, ['project', join(workspace, name)], {
          encoding:'utf8', timeout:10000,
        });
        assert.ifError(result.error);
        assert.equal(result.status === 0, accepted, `${name}: ${result.stderr}`);
        if (!accepted) assert.match(result.stderr, /non-portable component/, name);
      }
    }
  });

  await test('real metadata, parameter replay/reset, recursive events, and canceled buffer reloads', {timeout:30000}, async t => {
    const panel = createRunPanel('0.9.0', panelOptions());
    t.after(() => dispose(panel));
    panel.context.source = source;
    await panel.evaluate('refreshStoppedRunMetadata(source)');
    assert.equal(panel.evaluate("runPanelState.params.find(p=>p.name==='wide').default"), '9007199254740993');
    await panel.evaluate('runFile(source)');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'playback metadata');
    const state = () => panel.evaluate('runPanelState');
    assert.equal(state().params.find(p => p.name === 'wide').value, '9007199254740993');
    assert.deepEqual({...state().params.find(p => p.name === 'modes[1]').array}, {name:'modes',length:2,index:1});
    assert.equal(panel.evaluate('runSourceFiles.has(source)'), true);
    async function trigger(name, values = []) {
      await panel.receive({type:'triggerEvent', name, values, engineGeneration:panel.evaluate('String(runEngineGeneration)')});
      assert.equal(state().error, undefined);
    }
    await trigger('inspect');
    await until(() => state().logText.includes('value=9007199254740993'), 'exact initial parameter');
    await panel.receive({type:'setParam',name:'wide',value:'9223372036854775807'});
    await trigger('inspect');
    await until(() => state().logText.includes('value=9223372036854775807'), 'exact parameter edit');
    await panel.receive({type:'clearLog'});
    await panel.receive({type:'resetParams'});
    await trigger('inspect');
    await until(() => state().logText.includes('value=9007199254740993'), 'exact reset');
    const patch = {id:'9223372036854775807',mode:1,levels:[0.25,0.5],pair:[3,true]};
    await trigger('configure', [[patch]]);
    await until(() => state().logText.includes('9223372036854775807'), 'recursive delegate payload');
    assert.ok(state().logText.includes('"levels":[0.25,0.5]'));
    assert.equal(state().events.find(e => e.name === 'positive').args[0].value, 'Infinity');
    assert.equal(state().events.find(e => e.name === 'invalid').args[0].value, 'NaN');
    assert.equal(state().events.find(e => e.name === 'negative_zero').args[0].value, '-0');
    await trigger('positive');
    await trigger('invalid');
    await trigger('negative_zero');
    await until(() => state().logText.includes('value=Infinity') && state().logText.includes('value=NaN')
      && state().logText.includes('value=-0'), 'special float defaults');
    for (const name of ['negative_zero', 'negative_zero32']) {
      for (const value of ['-0', 0, '-0', 'NaN', 'Infinity', '-Infinity']) {
        await panel.receive({type:'clearLog'});
        await trigger(name, [value]);
        await until(() => state().logEntries.some(entry => entry?.kind === 'delegate'
          && entry.delegate.values.value === value), `${name} echo of ${value}`);
      }
    }
    const signedPatch = {...patch, levels:['-0', 0]};
    await panel.receive({type:'clearLog'});
    await trigger('configure', [[signedPatch]]);
    await until(() => state().logEntries.some(entry => entry?.kind === 'delegate'
      && entry.delegate.values.patch?.levels[0] === '-0'), 'nested signed zero');
    assert.deepEqual(JSON.parse(JSON.stringify(state().logEntries.at(-1).delegate.values.patch)), signedPatch);
    const wav = join(workspace, 'large.wav');
    const bytes = Buffer.alloc(32 * 1024 * 1024 + 44);
    bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
    bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(1,22);
    bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(32,34);
    bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);
    await writeFile(wav, bytes);
    let replies = '';
    const socket = panel.evaluate('runControlSocket');
    socket.on('data', data => { replies += data; });
    const bind = panel.receive({type:'bindBufferFile',name:'clip',filePath:wav});
    const clear = panel.receive({type:'clearBuffer',name:'clip'});
    await Promise.all([bind, clear]);
    assert.ok(replies.includes('"cancelled":true'), 'The real compiler must exercise cancellation');
    assert.equal(panel.evaluate("preservedRunBufferBindings.get('clip')"), null);
    await panel.evaluate('runFile(source,{restart:true})');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'reloaded playback');
    await panel.evaluate('refreshRunBuffers()');
    assert.equal(state().buffers.find(b => b.name === 'clip').loadedPath, null);
  });

  await test('a real control disconnect terminates playback and Play restores cached parameters', {timeout:30000}, async t => {
    const panel = createRunPanel('0.9.0', panelOptions());
    t.after(() => dispose(panel));
    panel.context.source = source;
    await panel.evaluate('runFile(source)');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'playback before disconnect');
    await panel.receive({type:'setParam',name:'wide',value:'9223372036854775807'});
    await panel.evaluate('sendRunControlRequest("getParams")');

    const child = panel.evaluate('runProcess');
    const exited = once(child, 'close');
    panel.evaluate('runControlSocket.end()');
    await until(() => panel.evaluate('runProcess===undefined && !!runPanelState.error'), 'disconnected playback cleanup');
    await exited;
    assert.ok(child.signalCode || child.exitCode !== null, 'Disconnected playback must exit');
    assert.equal(panel.evaluate('runPanelState.running || runPanelState.connected || runProcessingRequested'), false);
    assert.match(panel.evaluate('runPanelState.error'), /control connection.*Run again/);
    assert.equal(panel.evaluate('runPanelState.path'), source);
    assert.equal(panel.evaluate("runPanelState.params.find(p=>p.name==='wide').value"), '9223372036854775807');

    await panel.receive({type:'start'});
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'playback after disconnect');
    assert.notEqual(panel.evaluate('runProcess.pid'), child.pid);
    await panel.receive({type:'triggerEvent',name:'inspect',values:[],engineGeneration:panel.evaluate('String(runEngineGeneration)')});
    await until(() => panel.evaluate('runPanelState.logText.includes("value=9223372036854775807")'), 'restored parameter in restarted processor');
    assert.equal(panel.evaluate('runPanelState.error'), undefined);
  });

  await test('reload restores parameters and buffers before initialization and the first DSP block', {timeout:30000}, async t => {
    const file = join(workspace, 'startup.onda');
    await writeFile(file, `params:
  gain: f64 = 0.25
  choice: i32 = 1 {0, 10}
buffers:
  clip: f32
init:
  first = true
  initialized_gain = gain
  initialized_clip = clip[0]
  captured_gain: f64 = -1.0
  captured_choice = -1
  captured_clip = -1.0
block:
  if first:
    captured_gain = gain
    captured_choice = choice
    captured_clip = clip[0]
    first = false
delegate report(initialized_gain: f64, initialized_clip: f32, gain: f64, choice: i32, clip: f32)
event inspect():
  report(initialized_gain, initialized_clip, captured_gain, captured_choice, captured_clip)
sample:
  out1 = 0.0
`);
    const wav = join(workspace, 'startup.wav');
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 44);
    bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
    bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(1,22);
    bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(32,34);
    bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);bytes.writeFloatLE(0.5,44);
    await writeFile(wav, bytes);
    const panel = createRunPanel('0.9.0', panelOptions());
    t.after(() => dispose(panel));
    panel.context.source = file;
    await panel.evaluate('runFile(source)');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'initial playback');
    await panel.receive({type:'bindBufferFile',name:'clip',filePath:wav});
    // Restoration must use the exact targets even when normal edits are smoothed.
    await panel.evaluate('updateRunParamSmoothing(10000)');
    await panel.receive({type:'setParam',name:'gain',value:0.75});
    await panel.receive({type:'setParam',name:'choice',value:9});
    await panel.evaluate('sendRunControlRequest("getParams")');
    await panel.evaluate('runFile(source,{restart:true})');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'restored playback');
    await panel.receive({type:'triggerEvent',name:'inspect',values:[],engineGeneration:panel.evaluate('String(runEngineGeneration)')});
    await until(() => panel.evaluate('runPanelState.logEntries.some(entry=>entry?.delegate?.name==="report")'), 'first-block values');
    const values = panel.evaluate('runPanelState.logEntries.find(entry=>entry?.delegate?.name==="report").delegate.values');
    assert.deepEqual(JSON.parse(JSON.stringify(values)), {
      initialized_gain:0.75, initialized_clip:0.5, gain:0.75, choice:9, clip:0.5,
    });
    // A failed restore must not leave an instance that Play can start with defaults.
    await rm(wav);
    await panel.evaluate('runFile(source,{restart:true})');
    await until(() => panel.evaluate('runProcess===undefined && !!runPanelState.error'), 'failed buffer restoration');
    assert.equal(panel.evaluate('runProcessingRequested'), false);
    await writeFile(wav, bytes);
    await panel.receive({type:'start'});
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'retried restoration');
    await panel.receive({type:'triggerEvent',name:'inspect',values:[],engineGeneration:panel.evaluate('String(runEngineGeneration)')});
    await until(() => panel.evaluate('runPanelState.logEntries.some(entry=>entry?.delegate?.name==="report")'), 'retried first-block values');
    const retried = panel.evaluate('runPanelState.logEntries.find(entry=>entry?.delegate?.name==="report").delegate.values');
    assert.deepEqual(JSON.parse(JSON.stringify(retried)), JSON.parse(JSON.stringify(values)));
  });

  await test('reload restores controls before an initialization that faults with defaults', {timeout:30000}, async t => {
    const file = join(workspace, 'faulting-startup.onda');
    const fixture = initialization => `params:
  divisor: i32 = 0
init:
  value = ${initialization}
delegate report(value: i32)
event inspect():
  report(value)
sample:
  out1 = 0.0
`;
    await writeFile(file, fixture('0'));
    const panel = createRunPanel('0.9.0', panelOptions());
    t.after(() => dispose(panel));
    panel.context.source = file;
    await panel.evaluate('runFile(source)');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'initial playback');
    await panel.receive({type:'setParam',name:'divisor',value:1});
    await panel.evaluate('sendRunControlRequest("getParams")');
    await writeFile(file, fixture('i32(1) / divisor'));
    await panel.evaluate('runFile(source,{restart:true})');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'restored faulting-default playback');
    await panel.receive({type:'triggerEvent',name:'inspect',values:[],engineGeneration:panel.evaluate('String(runEngineGeneration)')});
    await until(() => panel.evaluate('runPanelState.logEntries.some(entry=>entry?.delegate?.name==="report")'), 'initialized value');
    assert.equal(panel.evaluate('runPanelState.logEntries.find(entry=>entry?.delegate?.name==="report").delegate.values.value'), 1);
    assert.equal(panel.evaluate('runPanelState.error'), undefined);
  });

  await test('reload restores every buffer before initialization accesses their contents', {timeout:30000}, async t => {
    const file = join(workspace, 'faulting-buffers.onda');
    const fixture = initialization => `buffers:
  first: f32
  second: f32
init:
  value = ${initialization}
delegate report(value: i32)
event inspect():
  report(value)
sample:
  out1 = 0.0
`;
    await writeFile(file, fixture('0'));
    const wav = join(workspace, 'faulting-buffers.wav');
    const bytes = Buffer.alloc(48);
    bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVEfmt ',8);
    bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(1,22);
    bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(32,34);
    bytes.write('data',36);bytes.writeUInt32LE(4,40);bytes.writeFloatLE(1.0,44);
    await writeFile(wav, bytes);
    const panel = createRunPanel('0.9.0', panelOptions());
    t.after(() => dispose(panel));
    panel.context.source = file;
    await panel.evaluate('runFile(source)');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'initial playback');
    for (const name of ['first', 'second']) {
      await panel.receive({type:'bindBufferFile',name,filePath:wav});
    }
    await writeFile(file, fixture('i32(1) / i32(first[0]) + i32(1) / i32(second[0])'));
    await panel.evaluate('runFile(source,{restart:true})');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'restored faulting-buffer playback');
    await panel.receive({type:'triggerEvent',name:'inspect',values:[],engineGeneration:panel.evaluate('String(runEngineGeneration)')});
    await until(() => panel.evaluate('runPanelState.logEntries.some(entry=>entry?.delegate?.name==="report")'), 'initialized buffer value');
    assert.equal(panel.evaluate('runPanelState.logEntries.find(entry=>entry?.delegate?.name==="report").delegate.values.value'), 2);
    assert.equal(panel.evaluate('runPanelState.error'), undefined);
  });

  await test('floating parameter defaults and native Reset remain exact through smoothing and reload', {timeout:30000}, async t => {
    const file = join(workspace, 'float-params.onda');
    const fixture = zero => `params:
  gain: f64 = 0.0 {0.0, 1.0}
  zero32: f32 = -0.0
  zero64: f64 = ${zero}
  positive32: f32 = 1.0 / 0.0
  positive64: f64 = 1.0 / 0.0
  negative32: f32 = -1.0 / 0.0
  negative64: f64 = -1.0 / 0.0
  invalid32: f32 = 0.0 / 0.0
  invalid64: f64 = 0.0 / 0.0
delegate snapshot(gain: f64, zero32: f32, zero64: f64, positive32: f32, positive64: f64, negative32: f32, negative64: f64, invalid32: f32, invalid64: f64)
event inspect():
  snapshot(gain, 1.0 / zero32, 1.0 / zero64, positive32, positive64, negative32, negative64, invalid32, invalid64)
sample:
  out1 = 0.0
`;
    await writeFile(file, fixture('-0.0'));
    const panel = createRunPanel('0.9.0', panelOptions());
    t.after(() => dispose(panel));
    panel.context.source = file;
    await panel.evaluate('refreshStoppedRunMetadata(source)');
    const state = () => panel.evaluate('runPanelState');
    const expected = {gain:0, zero32:'-Infinity', zero64:'-Infinity', positive32:'Infinity', positive64:'Infinity',
      negative32:'-Infinity', negative64:'-Infinity', invalid32:'NaN', invalid64:'NaN'};
    assert.equal(state().params.find(p => p.name === 'positive64').value, 'Infinity');
    await panel.evaluate('runFile(source)');
    await until(() => panel.evaluate('runPanelState.connected && runSchemaReady'), 'floating playback');
    async function snapshot() {
      await panel.receive({type:'clearLog'});
      await panel.receive({type:'triggerEvent',name:'inspect',values:[],engineGeneration:panel.evaluate('String(runEngineGeneration)')});
      await until(() => state().logEntries.some(entry => entry?.delegate?.name === 'snapshot'), 'processor snapshot');
      return JSON.parse(JSON.stringify(state().logEntries.find(entry => entry?.delegate?.name === 'snapshot').delegate.values));
    }
    assert.deepEqual(await snapshot(), expected);
    await panel.evaluate('updateRunParamSmoothing(0)');
    for (const param of state().params) await panel.receive({type:'setParam',name:param.name,value:1});
    await panel.evaluate('sendRunControlRequest("getParams")');
    await panel.evaluate('updateRunParamSmoothing(10000)');
    await panel.receive({type:'resetParams'});
    assert.deepEqual(await snapshot(), expected, 'Reset must immediately restore exact default bytes');
    for (const zero of ['0.0', '-0.0']) {
      await panel.receive({type:'setParam',name:'zero64',value:0.5});
      const generation = panel.evaluate('runEngineGeneration');
      await writeFile(file, fixture(zero));
      await until(() => panel.evaluate('runEngineGeneration') > generation
        && panel.evaluate('runPanelState.connected && runSchemaReady'), 'changed zero default');
      assert.equal((await snapshot()).zero64, zero === '-0.0' ? '-Infinity' : 'Infinity');
    }
  });

  await test('a failed Run save preserves an in-flight real metadata response', {timeout:15000}, async t => {
    let child;
    let metadataSent;
    const sent = new Promise(resolve => { metadataSent = resolve; });
    const proxy = {...childProcess, spawn(...args) {
      const spawned = childProcess.spawn(...args);
      if (args[0] !== command || !args[1].includes('daemon')) return spawned;
      child = spawned;
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (line, ...rest) => {
        if (line.includes('"command":"run_metadata"')) {
          // Gate the real reply to exercise a slow compile deterministically.
          child.stdout.pause();
          metadataSent();
        }
        return write(line, ...rest);
      };
      return child;
    }};
    const panel = createRunPanel('0.9.0', panelOptions({child_process:proxy}));
    t.after(() => dispose(panel));
    panel.context.source = source;
    panel.context.other = join(workspace, 'unsaved.onda');
    panel.evaluate(`runPanelState.path=source;
      vscode.window.showErrorMessage=async()=>undefined;
      vscode.workspace.textDocuments=[{uri:vscode.Uri.file(other),isDirty:true,save:async()=>false}];`);
    const refreshing = panel.evaluate('refreshStoppedRunMetadata(source)');
    await sent;
    await panel.evaluate('runFile(other)');
    assert.equal(child.killed, false, 'A failed save must leave the metadata compiler alive');
    child.stdout.resume();
    await refreshing;
    assert.equal(panel.evaluate('runSchemaReady'), true);
    assert.equal(panel.evaluate('runPanelState.path'), source);
    assert.equal(panel.evaluate('runPanelState.error'), undefined);
    assert.equal(panel.evaluate("runPanelState.params.find(p=>p.name==='wide').default"), '9007199254740993');
    assert.equal(panel.evaluate('cancelRunMetadata'), undefined);
  });

  await test('Stop terminates a real metadata compiler before its response', {timeout:15000}, async t => {
    let child;
    let metadataSent;
    const sent = new Promise(resolve => {metadataSent = resolve;});
    const proxy = {...childProcess, spawn(...args) {
      const spawned = childProcess.spawn(...args);
      if (args[0] !== command || !args[1].includes('daemon')) return spawned;
      child = spawned;
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (line, ...rest) => {
        const result = write(line, ...rest);
        if (line.includes('"command":"run_metadata"')) metadataSent();
        return result;
      };
      return child;
    }};
    const panel = createRunPanel('0.9.0', panelOptions({child_process:proxy}));
    t.after(() => dispose(panel));
    panel.context.source = source;
    const refreshing = panel.evaluate('refreshStoppedRunMetadata(source)');
    await sent;
    const closed = once(child, 'close');
    await panel.receive({type:'stop'});
    await Promise.all([refreshing, closed]);
    assert.ok(child.signalCode || child.exitCode !== null, 'Canceled metadata compiler must exit');
    assert.equal(panel.evaluate('cancelRunMetadata'), undefined);
  });
} finally {
  await rm(workspace, {recursive:true,force:true});
}
