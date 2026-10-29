const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const { resolveOndaExecutable } = require("../out/ondaExecutable.js");
const { describeOndaExecutableError } = require("../out/executableError.js");
const { createRunPanel } = require("./helpers/runPanel");

for (const [platform, arch, executable] of [
  ["linux", "x64", "onda"], ["win32", "x64", "onda.exe"], ["darwin", "arm64", "onda"],
]) {
  test(`bundled compiler resolves within the extension for ${platform}-${arch}`, () => {
    assert.equal(
      resolveOndaExecutable("/extension with spaces", "bundled", "/external/onda", platform, arch),
      path.join("/extension with spaces", "compiler", `${platform}-${arch}`, "bin", executable),
    );
  });
}

test("external compiler uses the explicit path or PATH", () => {
  assert.equal(resolveOndaExecutable("/extension", "external", "/custom path/onda"), "/custom path/onda");
  for (const setting of [undefined, "", "   "]) {
    assert.equal(resolveOndaExecutable("/extension", "external", setting), "onda");
  }
});

test("missing bundled compiler directs users to repair the package or choose external", () => {
  const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  const description = describeOndaExecutableError("/extension/compiler/linux-x64/bin/onda", error, "bundled");
  assert.equal(description.canConfigure, true);
  assert.match(description.message, /Reinstall/);
  assert.match(description.message, /onda.compiler.source/);
});

for (const source of [undefined, "bundled", "external"]) {
  test(`${source ?? "default"} compiler choice is shared by LSP, playback, metadata, and projects`, async () => {
    const launches = [];
    const servers = [];
    const panel = createRunPanel(undefined, {
      settings: { "compiler.source": source },
      modules: {
        "vscode-languageclient/node": {
          TransportKind: { stdio: 0 },
          LanguageClient: class {
            constructor(_id, _name, options) { servers.push(options); }
            async start() { this.initializeResult = { serverInfo: { version: "0.8.40" } }; }
          },
        },
        child_process: { spawn(command, args) {
          launches.push({ command, args });
          const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
          const child = Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), kill() {} });
          child.stdin = { end() {}, write(line) {
            const { id } = JSON.parse(line);
            queueMicrotask(() => child.stdout.emit("data", JSON.stringify({ id, ok: true, result: {} }) + "\n"));
          } };
          queueMicrotask(() => child.emit("close", 0));
          return child;
        } },
      },
    });
    panel.evaluate(`vscode.ProgressLocation = { Notification: 1 };
      vscode.window.withProgress = async (_options, task) => task();`);
    await panel.evaluate("startClient()");
    await panel.evaluate('runFile("/tmp/bundled-fixture.onda")');
    await panel.evaluate('loadStoppedRunMetadata("/tmp/bundled-fixture.onda")');
    assert.equal(await panel.evaluate('executeProjectCommand(["project", "/tmp/project"], "/tmp", "Create")'), true);
    const expected = source === "external" ? "/custom/onda"
      : resolveOndaExecutable(path.join(__dirname, ".."), "bundled");
    assert.equal(servers[0].run.command, expected);
    assert.equal(servers[0].debug.command, expected);
    assert.deepEqual(Array.from(servers[0].run.args), ["--custom-option", "lsp"]);
    assert.equal(launches.length, 3);
    assert.ok(launches.every(({ command }) => command === expected));
    assert.ok(launches.every(({ args }) => args[0] === "--custom-option"));
  });
}

test("compiler setting changes restart language services, while theme changes do not", async () => {
  const panel = createRunPanel();
  panel.evaluate(`let configurationChanged;
    let restarts = 0;
    vscode.window.createOutputChannel = () => ({ dispose() {} });
    vscode.workspace.onDidChangeConfiguration = callback => { configurationChanged = callback; return {}; };
    vscode.workspace.onDidSaveTextDocument = () => ({});
    vscode.commands = { registerCommand: () => ({}) };
    restartClient = async () => { restarts++; };
  `);
  await panel.evaluate("activate({ subscriptions: [], extensionPath: extensionRoot })");
  const initial = panel.evaluate("restarts");
  for (const setting of ["onda.compiler.source", "onda.server.path", "onda.server.args"]) {
    panel.context.changedSetting = setting;
    await panel.evaluate("configurationChanged({ affectsConfiguration: setting => setting === changedSetting })");
  }
  assert.equal(panel.evaluate("restarts"), initial + 3);
  await panel.evaluate('configurationChanged({ affectsConfiguration: setting => setting === "onda.run.theme" })');
  assert.equal(panel.evaluate("restarts"), initial + 3);
});

test("overlapping compiler restarts finish stopping the previous server before starting another", async () => {
  const pendingStarts = [];
  let running = 0;
  let stops = 0;
  const panel = createRunPanel(undefined, {
    modules: { "vscode-languageclient/node": {
      TransportKind: { stdio: 0 },
      LanguageClient: class {
        async start() {
          assert.equal(++running, 1, "Only one language server may run at once");
          await new Promise(resolve => pendingStarts.push(resolve));
        }
        async stop() { running--; stops++; }
      },
    } },
  });
  panel.evaluate("client = undefined; extensionContext.subscriptions = []");
  const first = panel.evaluate("restartClient()");
  const second = panel.evaluate("restartClient()");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pendingStarts.length, 1);
  pendingStarts[0]();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(pendingStarts.length, 2);
  pendingStarts[1]();
  await second;
  await panel.evaluate("deactivate()");
  assert.equal(running, 0);
});

for (const duringStart of [false, true]) {
  test(`deactivation cancels queued restarts${duringStart ? " during server startup" : " before startup"}`, async () => {
    let finishStart;
    let starts = 0;
    let running = 0;
    const panel = createRunPanel(undefined, {
      modules: { "vscode-languageclient/node": {
        TransportKind: { stdio: 0 },
        LanguageClient: class {
          async start() {
            starts++;
            running++;
            await new Promise(resolve => { finishStart = resolve; });
          }
          async stop() { running--; }
        },
      } },
    });
    panel.evaluate("client = undefined; extensionContext.subscriptions = []");
    const first = panel.evaluate("restartClient()");
    if (duringStart) await new Promise(resolve => setImmediate(resolve));
    const second = panel.evaluate("restartClient()");
    const shutdown = panel.evaluate("deactivate()");
    finishStart?.();
    await Promise.all([first, second, shutdown]);
    await panel.evaluate("restartClient()");
    assert.equal(starts, duringStart ? 1 : 0);
    assert.equal(running, 0);
  });
}

test("restarting the compiler reuses the extension's language file watchers", async () => {
  const panel = createRunPanel(undefined, {
    modules: { "vscode-languageclient/node": {
      TransportKind: { stdio: 0 },
      LanguageClient: class { async start() {} async stop() {} },
    } },
  });
  panel.evaluate(`client = undefined;
    let watchersCreated = 0;
    vscode.workspace.createFileSystemWatcher = () => { watchersCreated++; return { dispose() {} }; };
    vscode.window.createOutputChannel = () => ({ dispose() {} });
    vscode.workspace.onDidChangeConfiguration = () => ({});
    vscode.workspace.onDidSaveTextDocument = () => ({});
    vscode.commands = { registerCommand: () => ({}) };
  `);
  await panel.evaluate("activate({ subscriptions: [], extensionPath: extensionRoot })");
  assert.equal(panel.evaluate("watchersCreated"), 2);
  await panel.evaluate("restartClient()");
  await panel.evaluate("restartClient()");
  assert.equal(panel.evaluate("watchersCreated"), 2);
  await panel.evaluate("deactivate()");
});

for (const action of ["configure", "reject"]) {
  test(`an open startup error does not block recovery or shutdown (${action})`, async () => {
    let starts = 0;
    let stops = 0;
    const panel = createRunPanel(undefined, {
      modules: { "vscode-languageclient/node": {
        TransportKind: { stdio: 0 },
        LanguageClient: class {
          async start() {
            if (++starts === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          async stop() { stops++; }
        },
      } },
    });
    panel.evaluate(`client = undefined;
      let dismissError, rejectError;
      let configured = false;
      const notificationErrors = [];
      serverOutput = { appendLine: message => notificationErrors.push(message) };
      vscode.window.showErrorMessage = () => new Promise((resolve, reject) => {
        dismissError = resolve;
        rejectError = reject;
      });
      vscode.commands = { executeCommand: async () => { configured = true; } };
    `);
    // Observe completion while the notification is still unresolved. This also
    // fails promptly if a regression leaves the lifecycle promises pending.
    let completed = false;
    const lifecycle = (async () => {
      await panel.evaluate("restartClient()");
      await panel.evaluate("restartClient()");
      await panel.evaluate("deactivate()");
      completed = true;
    })();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, true);
    await lifecycle;
    assert.equal(starts, 2);
    assert.equal(stops, 1);
    if (action === "configure") {
      panel.evaluate("dismissError(CONFIGURE_EXECUTABLE_ACTION)");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(panel.evaluate("configured"), true);
    } else {
      panel.evaluate('rejectError(new Error("notification disposed"))');
      await new Promise(resolve => setImmediate(resolve));
      assert.match(panel.evaluate("notificationErrors.at(-1)"), /Failed to show compiler error:.*notification disposed/);
    }
  });
}
