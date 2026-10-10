const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const vm = require("node:vm");

function createRunPanel(version = "0.8.20", { settings = {}, modules = {} } = {}) {
  const extensionPath = path.join(__dirname, "..", "..", "out", "extension.js");
  const extensionRequire = createRequire(extensionPath);
  const messages = [];
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
    require(name) {
      if (name in modules) return modules[name];
      if (name === "vscode") return {
        ViewColumn: { Beside: 2 },
        Uri: { file: (file) => ({ scheme: "file", fsPath: file, toString: () => file }) },
        workspace: { textDocuments: [], getWorkspaceFolder: () => undefined, createFileSystemWatcher: () => ({}), getConfiguration: () => ({
          get: (key, fallback) => ({
            "server.path": "/custom/onda",
            "server.args": ["--custom-option"],
            ...settings,
          })[key] ?? fallback,
        }) },
        window: { createWebviewPanel: () => ({ webview, onDidDispose() {}, dispose() {}, reveal() {} }) },
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
  return { context, messages, receive, evaluate: source => vm.runInContext(source, context) };
}


module.exports = { createRunPanel };
