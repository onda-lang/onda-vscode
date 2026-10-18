const { EventEmitter } = require("node:events");
const { createRunPanel } = require("./runPanel");

function createLifecyclePanel(settings = {}) {
  const launches = [];
  const sockets = [];
  const daemonRequests = [];
  let daemonGraph = { files: ["/tmp/lifecycle.onda"], complete: true };
  let daemonMetadataGraph;
  let daemonError;
  const panel = createRunPanel(undefined, {
    settings,
    modules: {
      net: { createConnection() {
        const socket = Object.assign(new EventEmitter(), {
          destroyed: false, requests: [], setEncoding() {},
          destroy() { this.destroyed = true; this.emit("close"); },
          write(line, callback) { this.requests.push(JSON.parse(line)); callback?.(); },
        });
        sockets.push(socket);
        return socket;
      } },
      child_process: { spawn(command, args) {
        const child = Object.assign(new EventEmitter(), {
          stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
          stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
          kill() { this.killed = true; },
        });
        child.stdin = { end() {}, write(line) {
          const request = JSON.parse(line);
          daemonRequests.push(request);
          const error = request.command === "run_metadata" ? daemonError : undefined;
          const result = request.command === "run_sources" ? daemonGraph : {
            params: [{ name: "updated", type: "f32", default: 220 }],
            buffers: [{ name: "clip" }], events: [{ name: "bang", args: [] }],
            delegates: [], midi: { available: false, noteOn: false, noteOff: false },
            outputChannels: 2,
            sources: daemonMetadataGraph,
          };
          child.stdout.emit("data", JSON.stringify({ id: request.id, ok: !error, error, result }) + "\n");
        } };
        launches.push({ args, child });
        return child;
      } },
    },
  });
  panel.evaluate(`
    vscode.window.showWarningMessage = () => {};
    showOndaCommandError = async () => {};
    startScopePolling = () => {};
  `);
  return {
    ...panel, launches, sockets, daemonRequests,
    setDaemonGraph(graph) { daemonGraph = graph; },
    setDaemonMetadataGraph(graph) { daemonMetadataGraph = graph; },
    setDaemonError(error) { daemonError = error; },
    sources(files, complete = true) {
      launches.at(-1).child.stdout.emit("data", Buffer.from(JSON.stringify({ event: "sources", files, complete }) + "\n"));
    },
    savePath(file) {
      panel.context.savedFile = file;
      return panel.evaluate('restartRunForSavedDocument({ uri: vscode.Uri.file(savedFile) })');
    },
    state: () => panel.messages.at(-1).state,
    start: () => panel.evaluate('runFile("/tmp/lifecycle.onda")'),
    save: () => panel.evaluate(`restartRunForSavedDocument({
      languageId: "onda", uri: { scheme: "file", fsPath: "/tmp/lifecycle.onda" },
    })`),
    connect() {
      panel.evaluate("connectRunControl(1234); runPanelState.connected = true; runPanelState.running = true;");
      return sockets.at(-1);
    },
    reply(socket, request, result, error) {
      socket.emit("data", JSON.stringify({ id: request.id, ok: !error, result, error }) + "\n");
    },
  };
}

module.exports = { createLifecyclePanel };
