const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const vm = require("node:vm");
const { afterEach } = require("node:test");

const panels = new Set();
afterEach(() => {
  for (const panel of panels) panel.evaluate("disposeRunFileWatcher(); stopScopePolling(); languageDependencies?.dispose()");
  panels.clear();
});

function createRunPanel(version = "0.8.20", { settings = {}, workspaceSettings = {}, modules = {}, extensionDirectory = path.join(__dirname, "..", "..") } = {}) {
  const extensionPath = path.join(extensionDirectory, "out", "extension.js");
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    require(name) {
      if (name in modules) return modules[name];
      if (name === "vscode") return {
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        ViewColumn: { Beside: 2 },
        Uri: { file: (file) => ({ scheme: "file", fsPath: file, toString: () => file }) },
        workspace: { textDocuments: [], getWorkspaceFolder: () => undefined, createFileSystemWatcher: () => ({}), getConfiguration: () => ({
          inspect: (key) => ({ defaultValue: { "run.sampleRate": 48_000, "run.blockSize": 512 }[key], globalValue: settings[key], workspaceValue: workspaceSettings[key] }),
          get: (key, fallback) => ({
            "compiler.source": "external",
            "server.path": "/custom/onda",
            "server.args": ["--custom-option"],
            ...settings,
            ...workspaceSettings,
          })[key] ?? fallback,
          update: async (key, value, target) => { (target === 2 ? workspaceSettings : settings)[key] = value; },
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
