import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.argv[2];
const vsix = process.argv[3];
assert.ok(binary, 'Usage: npm run test:gpu-host -- <bundled|/path/to/onda> [package.vsix]');
const root = await mkdtemp(join(tmpdir(), 'onda-vscode-gpu-'));
let developmentPath = extension;
if (vsix) {
  const installed = spawnSync(process.env.VSCODE_BIN || 'code', ['--no-sandbox',
    `--user-data-dir=${join(root, 'profile')}`, `--extensions-dir=${join(root, 'extensions')}`,
    '--install-extension', resolve(vsix), '--force'], { stdio: 'inherit' });
  if (installed.error) throw installed.error;
  assert.equal(installed.status, 0, 'VSIX installation must succeed');
  const directory = (await readdir(join(root, 'extensions'))).find(name => name.startsWith('onda-lang.onda-vscode-'));
  assert.ok(directory, 'The packaged extension must be installed');
  developmentPath = join(root, 'extensions', directory);
}
await mkdir(join(root, 'workspace', '.vscode'), { recursive: true });
await writeFile(join(root, 'workspace', '.vscode', 'settings.json'), JSON.stringify({
  'onda.compiler.source': binary === 'bundled' ? 'bundled' : 'external',
  ...(binary === 'bundled' ? {} : { 'onda.server.path': resolve(binary) }),
  'onda.run.theme': 'light',
  'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'git.openRepositoryInParentFolders': 'never',
}));
const fixture = frequency => `params:\n  freq = ${frequency}.0 {20.0, 20000.0}\ninit:\n  phase = 0.0\n  previous = -1.0\nblock:\n  if freq != previous:\n    print(freq)\n    previous = freq\nsample:\n  out1 = sin(phase) * 0.00001\n  out2 = sin(phase) * 0.00001\n  phase = (phase + freq * TWO_PI / SR) % TWO_PI\n`;
const source = join(root, 'workspace', 'host.onda');
await writeFile(source, fixture(440));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
let log = '';
const child = spawn(process.env.VSCODE_BIN || 'code', ['--wait', '--no-sandbox', '--disable-dev-shm-usage',
  '--disable-workspace-trust', '--new-window', `--user-data-dir=${join(root, 'profile')}`,
  `--extensions-dir=${join(root, 'extensions')}`, `--extensionDevelopmentPath=${developmentPath}`,
  `--extensionTestsPath=${join(extension, 'test', 'host', 'gpu.js')}`, `--remote-debugging-port=${port}`,
  join(root, 'workspace')], { env: { ...process.env, ONDA_GPU_HOST_TEST_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => { log = (log + chunk).slice(-16000); });
child.stderr.on('data', chunk => { log = (log + chunk).slice(-16000); });
const ended = once(child, 'exit');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    if (child.exitCode !== null) throw new Error(`VS Code exited before ${description}: ${log}`);
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}\n${log}`);
}
const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
class Page {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.contexts = [];
    socket.addEventListener('close', () => {
      for (const task of this.pending.values()) task.reject(new Error('VS Code debugger connection closed'));
      this.pending.clear();
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.executionContextCreated') this.contexts.push(message.params.context);
      if (!message.id) return;
      const task = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    });
  }
  call(method, params = {}) {
    const id = ++this.id;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }
  async evaluate(expression, contextId) {
    const result = await this.call('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  canvas(expression) { return this.evaluate(expression, this.canvasContext); }
}
let page;
let request = 0;
async function host(action, error) {
  const id = ++request;
  await writeFile(join(root, 'request.json'), JSON.stringify({ id, action, error }));
  if (action !== 'done') await until(async () => {
    try { return JSON.parse(await readFile(join(root, 'ack.json'), 'utf8')).id === id; }
    catch { return false; }
  }, `host action ${action}`);
}
try {
  await until(async () => { try { return await targets(); } catch { return false; } }, 'debug endpoint');
  const target = await until(async () => (await targets()).find(t => t.type === 'iframe' && t.url.includes('onda-lang.onda-vscode')), 'GPU panel');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  page = new Page(socket);
  await until(async () => {
    const status=await page.evaluate(`(() => {const node=document.querySelector('iframe')?.contentDocument?.querySelector('#status');return {hidden:node?.hidden,text:node?.textContent};})()`);
    if (status.text?.startsWith("Could not render")) throw new Error(status.text);
    return status.hidden;
  }, 'canvas initialization');
  await page.call('Runtime.enable');
  const tree = await page.call('Page.getFrameTree');
  const frameId = tree.frameTree.childFrames[0].frame.id;
  page.canvasContext = page.contexts.find(c => c.auxData?.isDefault && c.auxData?.frameId === frameId)?.id;
  assert.ok(page.canvasContext, 'Canvas execution context must exist');
  await page.canvas(`(async () => {
    const { CanvasUi } = await import(new URL('./pkg/onda_ui.js', document.querySelector('script[src]').src));
    window.probe = { packets: 0, messages: [], inputs: [], commands: [] };
    const scope = CanvasUi.prototype.scope_packet;
    CanvasUi.prototype.scope_packet = function(bytes) {
      const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      probe.packets++; probe.channels = header.getUint16(4, true); probe.columns = header.getUint16(6, true);
      return scope.call(this, bytes);
    };
    const message = CanvasUi.prototype.message;
    CanvasUi.prototype.message = function(json) { probe.messages.push(JSON.parse(json)); return message.call(this, json); };
    const input = CanvasUi.prototype.input;
    CanvasUi.prototype.input = function(json) { const result = input.call(this, json); probe.inputs.push({event:JSON.parse(json), editing:this.editing()}); return result; };
    const commands = CanvasUi.prototype.commands;
    CanvasUi.prototype.commands = function() { const json = commands.call(this); probe.commands.push(...JSON.parse(json)); return json; };
    const textEdit = CanvasUi.prototype.text_edit;
    CanvasUi.prototype.text_edit = function() { const json = textEdit.call(this); probe.edit = JSON.parse(json); return json; };
  })()`);
  // The probe attaches after initialization. Ask the existing readiness
  // handshake for a fresh snapshot before asserting advertised capabilities.
  await page.canvas(`window.dispatchEvent(new MessageEvent('message', {data:{type:'requestRunViewReady'}}))`);
  await until(() => page.canvas('probe.messages.some(m => m.state?.supportsMidiInputSelection === true)'), 'initial capabilities');
  await until(() => page.canvas('probe.packets >= 10'), 'live compact scope data');
  assert.equal(await page.canvas('document.documentElement.dataset.theme'), 'light', 'Explicit light theme must reach the canvas');
  await host('theme:dark');
  await until(() => page.canvas('document.documentElement.dataset.theme === "dark"'), 'live theme preference');
  await host('theme:auto');
  await host('workbenchLight');
  await until(() => page.canvas('document.documentElement.dataset.theme === "light"'), 'automatic VS Code theme tracking');
  const scope = await page.canvas('({channels:probe.channels,columns:probe.columns})');
  assert.equal(scope.channels, 2);
  assert.ok(scope.columns > 0 && scope.columns <= 512);
  const workbenchTarget = (await targets()).find(t => t.type === 'page');
  const workbenchSocket = new WebSocket(workbenchTarget.webSocketDebuggerUrl);
  await once(workbenchSocket, 'open');
  const workbench = new Page(workbenchSocket);
  // Fresh profiles may show VS Code's first-run onboarding above the panel.
  // Dismiss it through its ordinary controls before capturing the actual UI.
  for (let step = 0; step < 3; step++) {
    await workbench.evaluate(`(() => {
      const button=[...document.querySelectorAll('button')].find(b=>['Continue without Signing In','Get Started'].includes(b.textContent.trim()));
      button?.click();
    })()`);
    await delay(150);
  }
  const screenshot = await workbench.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(root, 'vscode.png'), Buffer.from(screenshot.data, 'base64'));
  workbenchSocket.close();
  await page.canvas('document.querySelector("canvas").focus()');
  for (let step = 0; step < 40; step++) {
    await page.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',windowsVirtualKeyCode:9});
    if (await page.canvas('document.activeElement.tagName === "TEXTAREA" && document.activeElement.value === "440"')) break;
  }
  assert.equal(await page.canvas('document.activeElement.tagName'), 'TEXTAREA', 'Tab must reach the parameter text editor');
  const editorGeometry = await page.canvas(`(() => {
    const canvas = document.querySelector('canvas').getBoundingClientRect();
    const editor = document.activeElement.getBoundingClientRect(), field = probe.edit.rect;
    return {actual:[editor.left,editor.top,editor.width,editor.height],
      expected:[canvas.left+field[0],canvas.top+field[1],field[2],field[3]]};
  })()`);
  for (let i = 0; i < 4; i++)
    assert.ok(Math.abs(editorGeometry.actual[i] - editorGeometry.expected[i]) < 0.1,
      `Native editor must align with the canvas field: ${JSON.stringify(editorGeometry)}`);
  await page.call('Input.insertText', {text:'880'});
  await page.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',windowsVirtualKeyCode:13});
  await until(() => page.canvas(`probe.messages.some(m => m.state?.logText?.split('\\n').some(line=>Number(line)===880))`), 'parameter reaching the audio processor');
  assert.ok(await page.canvas('probe.messages.some(m => m.state?.supportsMidiInputSelection === true)'), 'MIDI selection capability must reach the shared screen');
  await host('hide');
  await delay(150);
  const hidden = await page.canvas('probe.packets');
  await delay(350);
  assert.equal(await page.canvas('probe.packets'), hidden, 'Hidden panel must stop scope work');
  await host('show');
  await until(() => page.canvas(`probe.packets > ${hidden + 2}`), 'scope after showing the panel');
  await writeFile(source, fixture(220));
  await until(() => page.canvas(`probe.messages.some(m => m.type==='state' && m.state?.params?.some(p=>p.name==='freq' && p.value===220))`), 'source reload');
  assert.equal(await page.canvas('document.querySelector("#status").hidden'), true, 'Renderer must remain healthy');
  await writeFile(join(root, 'result.json'), JSON.stringify({ passed: true, scope, extension: developmentPath, vsix: vsix ? resolve(vsix) : null,
    checks: ['real extension host', 'real playback', 'compact scope', 'numeric editor alignment', 'native text entry reaching audio processor', 'MIDI selection capability', 'explicit and automatic theme changes', 'hidden panel', 'show panel', 'source reload'] }, null, 2));
  await host('done');
  page.socket.close();
  const [code] = await ended;
  assert.equal(code, 0, log);
  console.log(`GPU extension host checks passed. Evidence: ${root}/result.json`);
} catch (error) {
  if (page) {
    try { await writeFile(join(root, 'failure.json'), JSON.stringify(await page.canvas('({probe,body:document.body.innerText,status:document.querySelector("#status")?.outerHTML})'), null, 2)); }
    catch { /* The application may already have exited. */ }
  }
  await host('done', String(error)).catch(() => {});
  page?.socket.close();
  console.error(`Host test artifacts: ${root}\n${log}`);
  throw error;
}
