const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const vm = require("node:vm");
const { afterEach } = require("node:test");

const panels = new Set();
afterEach(() => {
  for (const panel of panels) panel.evaluate("disposeRunFileWatcher(); stopScopePolling()");
  panels.clear();
});

function createRunPanel(version = "0.8.20", { settings = {}, modules = {} } = {}) {
  const extensionPath = path.join(__dirname, "..", "..", "out", "extension.js");
  const extensionRequire = createRequire(extensionPath);
  const messages = [];
  const panelReveals = [];
  const panelCreations = [];
  const statusMessages = [];
  let receive;
  const webview = {
    cspSource: "test:",
    asWebviewUri: (uri) => uri,
    onDidReceiveMessage(handler) { receive = handler; },
    postMessage: (message) => messages.push(message),
  };
  const context = vm.createContext({
    exports: {},
    ondaVersion: version,
    extensionRoot: path.dirname(path.dirname(extensionPath)),
    __dirname: path.dirname(extensionPath),
    process,
    setInterval,
    clearInterval,
    require(name) {
      if (name in modules) return modules[name];
      if (name === "vscode") return {
        ViewColumn: { Beside: 2 },
        Uri: { file: (file) => ({ scheme: "file", fsPath: file, toString: () => file }) },
        workspace: { textDocuments: [], getWorkspaceFolder: () => undefined, createFileSystemWatcher: () => ({}), getConfiguration: () => ({
          inspect: (key) => ({ defaultValue: { "run.sampleRate": 48_000, "run.blockSize": 512 }[key], globalValue: settings[key] }),
          get: (key, fallback) => ({
            "server.path": "/custom/onda",
            "server.args": ["--custom-option"],
            ...settings,
          })[key] ?? fallback,
        }) },
        window: { setStatusBarMessage(text, timeout) {
          const message = { text, timeout, disposed: false };
          statusMessages.push(message);
          return { dispose() { message.disposed = true; } };
        }, createWebviewPanel: (type, title, showOptions) => {
          panelCreations.push(showOptions);
          let dispose;
          let viewStateChanged;
          return { webview, onDidChangeViewState(handler) { viewStateChanged = handler; }, setVisible(visible) { this.visible = visible; viewStateChanged?.(); }, onDidDispose(handler) { dispose = handler; }, dispose() { dispose?.(); },
            reveal(column, preserveFocus) { panelReveals.push({ column, preserveFocus }); } };
        } },
      };
      if (name === "vscode-languageclient/node") return {
        TransportKind: { stdio: 0 },
        LanguageClient: class {
          async start() {
            this.initializeResult = { serverInfo: { version: "0.8.20" } };
          }
        },
      };
      return extensionRequire(name);
    },
  });
  vm.runInContext(fs.readFileSync(extensionPath, "utf8") + "\nextensionContext = { extensionPath: extensionRoot }; client = { initializeResult: { serverInfo: { version: ondaVersion } } }; ensureRunPanel();", context);
  const panel = { context, messages, panelReveals, panelCreations, statusMessages, receive, evaluate: source => vm.runInContext(source, context) };
  panels.add(panel);
  return panel;
}


module.exports = { createRunPanel };
