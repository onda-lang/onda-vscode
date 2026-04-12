import * as childProcess from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

type RunScalarValue = boolean | number | null;

interface RunParamPayload {
  index: number;
  name: string;
  type: string;
  value: RunScalarValue;
  default: number | null;
  rangeMin: number | null;
  rangeMax: number | null;
  scalar: boolean;
}

interface RunParamState extends RunParamPayload {}

interface RunBufferPayload {
  index: number;
  name: string;
  type: string;
  channelsKind: "mono" | "static" | "dynamic";
  channelsStatic: number | null;
  loadedPath: string | null;
}

interface RunBufferState extends RunBufferPayload {}

interface RunEventArgPayload {
  index: number;
  name: string;
  type: string;
  default?: RunScalarValue;
  value?: RunScalarValue;
}

interface RunEventArgState extends RunEventArgPayload {
  value: RunScalarValue;
}

interface RunEventPayload {
  index: number;
  name: string;
  args: RunEventArgPayload[];
}

interface RunEventState {
  index: number;
  name: string;
  args: RunEventArgState[];
}

interface RunReadyEvent {
  event: "ready";
  path: string;
  port: number;
  params: RunParamPayload[];
  buffers: RunBufferPayload[];
  events: RunEventPayload[];
  outputChannels: number;
  inputDevices: string[];
  outputDevices: string[];
  currentInputDevice: string | null;
  currentOutputDevice: string | null;
}

interface RunPanelState {
  running: boolean;
  connected: boolean;
  path?: string;
  status: string;
  error?: string;
  outputChannels: number;
  buffers: RunBufferState[];
  events: RunEventState[];
  params: RunParamState[];
  inputDevices: string[];
  outputDevices: string[];
  currentInputDevice: string | null;
  currentOutputDevice: string | null;
}

interface PendingControlRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

let client: LanguageClient | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let runProcess: childProcess.ChildProcessWithoutNullStreams | undefined;
let runPath: string | undefined;
let runOutput: vscode.OutputChannel | undefined;
let serverOutput: vscode.OutputChannel | undefined;
let runPanel: vscode.WebviewPanel | undefined;
let runPanelReady = false;
let runControlSocket: net.Socket | undefined;
let runControlBuffer = "";
let runStdoutBuffer = "";
let runControlRequestId = 0;
let stoppingRunPid: number | undefined;
const pendingRunRequests = new Map<number, PendingControlRequest>();
const runKillTimers = new Map<number, NodeJS.Timeout>();
let scopePollingTimer: NodeJS.Timeout | undefined;
let scopePollingInFlight = false;
const SCOPE_MAX_FRAMES = 1024;
const SCOPE_POLL_INTERVAL_MS = 50;
const RUN_FORCE_KILL_DELAY_MS = 1500;
let runPanelState: RunPanelState = {
  running: false,
  connected: false,
  status: "Stopped",
  outputChannels: 0,
  buffers: [],
  events: [],
  params: [],
  inputDevices: [],
  outputDevices: [],
  currentInputDevice: null,
  currentOutputDevice: null,
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  runOutput = vscode.window.createOutputChannel("Onda Run");
  serverOutput = vscode.window.createOutputChannel("Onda Language Server");
  context.subscriptions.push(runOutput, serverOutput);

  context.subscriptions.push(
    vscode.commands.registerCommand("onda.restartLanguageServer", async () => {
      await restartClient();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("onda.runFile", async () => {
      await runFile();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("onda.stopFile", async () => {
      await stopFile();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      await restartRunForSavedDocument(document);
    }),
  );

  await startClient(context);
}

export async function deactivate(): Promise<void> {
  await stopFile({ silent: true });

  if (!client) {
    return;
  }
  const activeClient = client;
  client = undefined;
  try {
    await activeClient.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Client is not running")) {
      throw error;
    }
  }
}

async function restartClient(): Promise<void> {
  await deactivate();
  if (!extensionContext) {
    throw new Error("Onda extension context is not initialized");
  }
  await startClient(extensionContext);
}

async function runFile(preferredPath?: string, options?: { restart?: boolean }): Promise<void> {
  const fsPath = await resolveRunPath(preferredPath);
  if (!fsPath) {
    return;
  }
  const runHost = ondaRunHostSetting();
  const runTheme = ondaRunThemeSetting();

  if (runHost === "webview") {
    ensureRunPanel();
  } else if (runPanel) {
    runPanel.dispose();
  }
  const preservedParams =
    runPanelState.path === fsPath ? runPanelState.params : [];
  const preservedEvents =
    runPanelState.path === fsPath ? runPanelState.events : [];
  runPanelState = {
    running: false,
    connected: false,
    path: fsPath,
    status: `Starting ${path.basename(fsPath)}...`,
    error: undefined,
    outputChannels: runPanelState.path === fsPath ? runPanelState.outputChannels : 0,
    buffers: runPanelState.path === fsPath ? runPanelState.buffers : [],
    events: preservedEvents,
    params: preservedParams,
    inputDevices: runPanelState.inputDevices,
    outputDevices: runPanelState.outputDevices,
    currentInputDevice: runPanelState.currentInputDevice,
    currentOutputDevice: runPanelState.currentOutputDevice,
  };
  postRunPanelState();

  if (runProcess && runPath === fsPath && !options?.restart) {
    if (runHost === "webview") {
      revealRunPanel();
    }
    return;
  }

  await stopFile({ silent: true, preservePath: fsPath });

  const { command, extraArgs } = ondaExecutableConfig();
  const args =
    runHost === "egui"
      ? [...extraArgs, "run", fsPath, "--theme", runTheme]
      : [...extraArgs, "run", "play", fsPath, "--forever", "--control-json"];
  if (runPanelState.currentInputDevice) {
    args.push("--input-device", runPanelState.currentInputDevice);
  }
  if (runPanelState.currentOutputDevice) {
    args.push("--output-device", runPanelState.currentOutputDevice);
  }
  const cwd = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))?.uri.fsPath ?? path.dirname(fsPath);
  const child = childProcess.spawn(command, args, {
    cwd,
    stdio: "pipe",
    detached: process.platform !== "win32",
  });

  runProcess = child;
  runPath = fsPath;
  runStdoutBuffer = "";
  let runStderrBuffer = "";

  runOutput?.appendLine(`$ ${command} ${args.map(shellQuote).join(" ")}`);
  runOutput?.show(true);
  if (runHost === "webview") {
    revealRunPanel();
  }

  child.stdout.on("data", (chunk: Buffer) => {
    if (runHost === "webview") {
      handleRunStdout(chunk.toString());
    } else {
      runOutput?.append(chunk.toString());
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    runStderrBuffer += text;
    runOutput?.append(text);
  });
  child.once("error", (error: Error) => {
    const failedPath = fsPath;
    if (runProcess === child) {
      clearRunRuntimeState({ preservePath: failedPath });
    }
    runPanelState = {
      ...runPanelState,
      running: false,
      connected: false,
      path: failedPath,
      status: "Failed to start",
      error: error.message,
    };
    postRunPanelState();
    runOutput?.show(true);
    void vscode.window.showErrorMessage(
      `Failed to start Onda run${failedPath ? ` (${path.basename(failedPath)})` : ""}: ${error.message}`,
    );
  });
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    const finishedPath = fsPath;
    clearRunKillTimer(child.pid);
    const expectedStop = child.pid !== undefined && stoppingRunPid === child.pid;
    const exitError = expectedStop ? undefined : formatRunExitError(runStderrBuffer, code, signal);
    if (expectedStop) {
      stoppingRunPid = undefined;
    }
    if (runProcess === child) {
      clearRunRuntimeState({ preservePath: finishedPath });
    }
    runPanelState = {
      ...runPanelState,
      running: false,
      connected: false,
      path: finishedPath,
      status: expectedStop ? "Stopped" : "Run exited",
      error: exitError,
    };
    postRunPanelState();
    if (expectedStop) {
      return;
    }
    if (signal === null && code === 0) {
      return;
    }
    const reason = exitError ?? (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
    runOutput?.show(true);
    void vscode.window.showWarningMessage(
      `Onda run stopped${finishedPath ? ` (${path.basename(finishedPath)})` : ""}: ${reason}`,
    );
  });
}

async function stopFile(options?: { silent?: boolean; preservePath?: string }): Promise<void> {
  if (!runProcess) {
    if (!options?.silent) {
      void vscode.window.showInformationMessage("No Onda run is currently running.");
    }
    runPanelState = {
      ...runPanelState,
      running: false,
      connected: false,
      status: "Stopped",
    };
    postRunPanelState();
    return;
  }

  const child = runProcess;
  const runningPath = runPath;
  clearRunRuntimeState({ preservePath: options?.preservePath ?? runningPath });
  stoppingRunPid = child.pid;
  terminateRunProcessTree(child);

  runPanelState = {
    ...runPanelState,
    running: false,
    connected: false,
    path: options?.preservePath ?? runningPath,
    status: "Stopped",
    error: undefined,
  };
  postRunPanelState();

  if (!options?.silent && runningPath) {
    void vscode.window.showInformationMessage(`Stopped Onda run: ${path.basename(runningPath)}`);
  }
}

function clearRunRuntimeState(options?: { preservePath?: string }): void {
  runProcess = undefined;
  runPath = options?.preservePath;
  runStdoutBuffer = "";
  closeRunControlSocket();
}

function terminateRunProcessTree(child: childProcess.ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid) {
    const killer = childProcess.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => {
      try {
        child.kill();
      } catch {
        // Ignore termination fallback errors.
      }
    });
    return;
  }

  const pid = child.pid;
  if (!pid) {
    try {
      child.kill();
    } catch {
      // Ignore termination errors for already-exited children.
    }
    return;
  }

  terminateUnixRunProcess(pid);
}

function terminateUnixRunProcess(pid: number): void {
  const groupPid = -pid;
  try {
    process.kill(groupPid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  clearRunKillTimer(pid);
  const timer = setTimeout(() => {
    runKillTimers.delete(pid);
    try {
      process.kill(groupPid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore termination errors for already-exited children.
      }
    }
  }, RUN_FORCE_KILL_DELAY_MS);
  timer.unref();
  runKillTimers.set(pid, timer);
}

function clearRunKillTimer(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  const timer = runKillTimers.get(pid);
  if (timer) {
    clearTimeout(timer);
    runKillTimers.delete(pid);
  }
}

async function restartRunForSavedDocument(document: vscode.TextDocument): Promise<void> {
  if (document.languageId !== "onda" || document.uri.scheme !== "file") {
    return;
  }
  const activePath = runPath ?? runPanelState.path;
  if (!activePath) {
    return;
  }
  if (path.resolve(document.uri.fsPath) !== path.resolve(activePath)) {
    return;
  }
  if (runProcess && runPath) {
    await runFile(document.uri.fsPath, { restart: true });
    return;
  }
  await refreshStoppedRunMetadata(document.uri.fsPath);
}

async function resolveRunPath(preferredPath?: string): Promise<string | undefined> {
  if (preferredPath) {
    return preferredPath;
  }
  const document = await currentRunDocument();
  if (!document) {
    return undefined;
  }

  if (document.isDirty) {
    const saved = await document.save();
    if (!saved) {
      void vscode.window.showErrorMessage("Onda run must be saved before playback starts.");
      return undefined;
    }
  }

  return document.uri.fsPath;
}

async function currentRunDocument(): Promise<vscode.TextDocument | undefined> {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  if (!document || document.languageId !== "onda") {
    void vscode.window.showErrorMessage("Open an Onda file to run a run.");
    return undefined;
  }
  if (document.uri.scheme !== "file") {
    void vscode.window.showErrorMessage("Onda run playback currently requires a saved file on disk.");
    return undefined;
  }
  return document;
}

function ondaExecutableConfig(): { command: string; extraArgs: string[] } {
  const config = vscode.workspace.getConfiguration("onda");
  const configuredPath = config.get<string>("server.path");
  return {
    command: configuredPath && configuredPath.trim().length > 0 ? configuredPath : "onda",
    extraArgs: config.get<string[]>("server.args", []),
  };
}

function shellQuote(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function trimRunErrorText(text: string, maxChars = 4000): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `â€¦${trimmed.slice(trimmed.length - maxChars)}`;
}

function formatRunExitError(stderrText: string, code: number | null, signal: NodeJS.Signals | null): string {
  return trimRunErrorText(stderrText) ?? (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
}

async function refreshStoppedRunMetadata(fsPath: string): Promise<void> {
  try {
    const result = await loadStoppedRunMetadata(fsPath);
    const params = normalizeStoppedRunParams(result.params);
    runPanelState = {
      ...runPanelState,
      path: fsPath,
      status: "Stopped",
      error: undefined,
      outputChannels:
        typeof result.output_channels === "number"
          ? result.output_channels
          : runPanelState.outputChannels,
      params: params
        ? mergeRunParams(params, runPanelState.params)
        : runPanelState.params,
    };
    postRunPanelState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      path: fsPath,
      status: "Stopped",
      error: message,
    };
    postRunPanelState();
  }
}

async function loadStoppedRunMetadata(
  fsPath: string,
): Promise<{ params?: RunParamPayload[]; output_channels?: number }> {
  const { command, extraArgs } = ondaExecutableConfig();
  const cwd =
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))?.uri.fsPath ?? path.dirname(fsPath);

  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, [...extraArgs, "daemon", "stdio"], {
      cwd,
      stdio: "pipe",
      windowsHide: true,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      pending.clear();
      try {
        child.stdin.end();
      } catch {
        // Ignore stdin close errors during shutdown.
      }
      try {
        child.kill();
      } catch {
        // Ignore termination errors for already-exited children.
      }
      fn();
    };

    const fail = (message: string) => {
      finish(() => reject(new Error(message)));
    };

    const sendRequest = (commandName: string, payload?: Record<string, unknown>): Promise<any> => {
      return new Promise((requestResolve, requestReject) => {
        const id = nextId++;
        pending.set(id, { resolve: requestResolve, reject: requestReject });
        const request = JSON.stringify({
          id,
          command: commandName,
          ...payload,
        });
        child.stdin.write(`${request}\n`, (error?: Error | null) => {
          if (!error) {
            return;
          }
          pending.delete(id);
          requestReject(error);
        });
      });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        let payload: { id?: number; ok?: boolean; result?: unknown; error?: string };
        try {
          payload = JSON.parse(line);
        } catch (error) {
          fail(`invalid daemon response: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (typeof payload.id !== "number") {
          continue;
        }
        const request = pending.get(payload.id);
        if (!request) {
          continue;
        }
        pending.delete(payload.id);
        if (payload.ok) {
          request.resolve(payload.result);
        } else {
          request.reject(new Error(payload.error ?? "daemon request failed"));
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
    });

    child.once("error", (error: Error) => {
      fail(`failed to start daemon metadata refresh: ${error.message}`);
    });

    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      const stderrText = trimRunErrorText(stderrBuffer);
      const reason = stderrText ?? (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
      fail(`daemon metadata refresh exited unexpectedly: ${reason}`);
    });

    void sendRequest("run_start", { path: fsPath })
      .then((result) => {
        finish(() => resolve(result ?? {}));
      })
      .catch((error: Error) => {
        fail(error.message);
      });
  });
}

function normalizeStoppedRunParams(raw: unknown): RunParamPayload[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw.map((param) => {
    const source = (param ?? {}) as Record<string, unknown>;
    return {
      index: typeof source.index === "number" ? source.index : 0,
      name: typeof source.name === "string" ? source.name : "",
      type:
        typeof source.type === "string"
          ? source.type
          : typeof source.type_repr === "string"
            ? source.type_repr
            : "f32",
      value:
        typeof source.value === "boolean" || typeof source.value === "number" || source.value === null
          ? source.value as RunScalarValue
          : null,
      default: typeof source.default === "number" ? source.default : null,
      rangeMin:
        typeof source.rangeMin === "number"
          ? source.rangeMin
          : typeof source.range_min === "number"
            ? source.range_min
            : null,
      rangeMax:
        typeof source.rangeMax === "number"
          ? source.rangeMax
          : typeof source.range_max === "number"
            ? source.range_max
            : null,
      scalar: source.scalar !== false,
    };
  });
}

function handleRunStdout(chunk: string): void {
  runStdoutBuffer += chunk;
  for (;;) {
    const newline = runStdoutBuffer.indexOf("\n");
    if (newline < 0) {
      break;
    }
    const line = runStdoutBuffer.slice(0, newline).trim();
    runStdoutBuffer = runStdoutBuffer.slice(newline + 1);
    if (line.length === 0) {
      continue;
    }
    handleRunStdoutLine(line);
  }
}

function handleRunStdoutLine(line: string): void {
  try {
    const payload = JSON.parse(line) as RunReadyEvent;
    if (payload.event === "ready") {
      runPanelState = {
        running: true,
        connected: false,
        path: runPath,
        status: "Running",
        error: undefined,
        outputChannels: payload.outputChannels ?? 0,
        buffers: mergeRunBuffers(payload.buffers ?? [], runPanelState.buffers),
        events: mergeRunEvents(payload.events ?? [], runPanelState.events),
        params: mergeRunParams(payload.params, runPanelState.params),
        inputDevices: payload.inputDevices ?? [],
        outputDevices: payload.outputDevices ?? [],
        currentInputDevice: payload.currentInputDevice ?? null,
        currentOutputDevice: payload.currentOutputDevice ?? null,
      };
      postRunPanelState();
      connectRunControl(payload.port);
      return;
    }
  } catch {
    // Fall through to raw output logging.
  }

  runOutput?.appendLine(line);
}

// Merge new param metadata with previously-preserved user values (across restarts).
// Default value hydration is handled by the webview (run.html).
function mergeRunParams(
  params: RunParamPayload[],
  existing: RunParamState[],
): RunParamState[] {
  return params
    .filter((param) => param.scalar)
    .map((param) => {
      const previous = existing.find((item) => item.name === param.name);
      return {
        ...param,
        value:
          previous && runParamsMatchForPreservation(param, previous)
            ? previous.value
            : initialParamValue(param),
      };
    });
}

function runParamsMatchForPreservation(
  next: RunParamPayload,
  previous: RunParamState,
): boolean {
  return (
    next.name === previous.name &&
    next.type === previous.type &&
    next.default === previous.default &&
    next.rangeMin === previous.rangeMin &&
    next.rangeMax === previous.rangeMax &&
    next.scalar === previous.scalar
  );
}

function mergeRunBuffers(
  buffers: RunBufferPayload[],
  existing: RunBufferState[],
): RunBufferState[] {
  return buffers.map((buffer) => {
    const previous = existing.find((item) => item.name === buffer.name);
    return {
      ...buffer,
      loadedPath: previous?.loadedPath ?? buffer.loadedPath,
    };
  });
}

function mergeRunEvents(
  events: RunEventPayload[],
  existing: RunEventState[],
): RunEventState[] {
  return events.map((event) => {
    const previous = existing.find((item) => item.name === event.name);
    return {
      ...event,
      args: (event.args ?? []).map((arg) => {
        const previousArg =
          previous?.args.find((item) => item.name === arg.name) ??
          previous?.args[arg.index];
        return {
          ...arg,
          value: previousArg?.value ?? initialEventArgValue(arg),
        };
      }),
    };
  });
}

function connectRunControl(port: number): void {
  closeRunControlSocket();

  const socket = net.createConnection({ host: "127.0.0.1", port });
  runControlSocket = socket;
  runControlBuffer = "";

  socket.setEncoding("utf8");
  socket.on("connect", () => {
    runPanelState = {
      ...runPanelState,
      connected: true,
      status: "Running",
      error: undefined,
    };
    postRunPanelState();
    void Promise.all([refreshRunParams(), refreshRunBuffers(), refreshRunEvents()]).then(() => {
      reapplyCachedRunParams();
      reapplyCachedRunBuffers();
    });
    startScopePolling();
  });
  socket.on("data", (chunk: string) => {
    runControlBuffer += chunk;
    for (;;) {
      const newline = runControlBuffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = runControlBuffer.slice(0, newline).trim();
      runControlBuffer = runControlBuffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      handleRunControlLine(line);
    }
  });
  socket.on("error", (error: Error) => {
    stopScopePolling();
    runPanelState = {
      ...runPanelState,
      connected: false,
      error: error.message,
    };
    postRunPanelState();
  });
  socket.on("close", () => {
    stopScopePolling();
    if (runControlSocket === socket) {
      runControlSocket = undefined;
      runControlBuffer = "";
      rejectPendingRunRequests(new Error("Run control connection closed."));
      runPanelState = {
        ...runPanelState,
        connected: false,
      };
      postRunPanelState();
    }
  });
}

function closeRunControlSocket(): void {
  if (runControlSocket) {
    runControlSocket.destroy();
    runControlSocket = undefined;
  }
  runControlBuffer = "";
  clearRunParamDisrun();
  rejectPendingRunRequests(new Error("Run control session ended."));
}

function handleRunControlLine(line: string): void {
  const payload = JSON.parse(line) as { id?: number; ok?: boolean; result?: unknown; error?: string };
  if (typeof payload.id !== "number") {
    return;
  }
  const pending = pendingRunRequests.get(payload.id);
  if (!pending) {
    return;
  }
  pendingRunRequests.delete(payload.id);
  if (payload.ok) {
    pending.resolve(payload.result);
  } else {
    pending.reject(new Error(payload.error ?? "Run control request failed."));
  }
}

function rejectPendingRunRequests(error: Error): void {
  for (const pending of pendingRunRequests.values()) {
    pending.reject(error);
  }
  pendingRunRequests.clear();
}

async function refreshRunParams(): Promise<void> {
  try {
    const result = await sendRunControlRequest<{ params: RunParamPayload[] }>("getParams");
    if (!result || !Array.isArray(result.params)) {
      return;
    }
    runPanelState = {
      ...runPanelState,
      params: mergeRunParams(result.params, runPanelState.params),
    };
    postRunPanelState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

async function refreshRunBuffers(): Promise<void> {
  try {
    const result = await sendRunControlRequest<{ buffers: RunBufferPayload[] }>("getBuffers");
    if (!result || !Array.isArray(result.buffers)) {
      return;
    }
    runPanelState = {
      ...runPanelState,
      buffers: mergeRunBuffers(result.buffers, runPanelState.buffers),
    };
    postRunPanelState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

async function refreshRunEvents(): Promise<void> {
  try {
    const result = await sendRunControlRequest<{ events: RunEventPayload[] }>("getEvents");
    if (!result || !Array.isArray(result.events)) {
      return;
    }
    runPanelState = {
      ...runPanelState,
      events: mergeRunEvents(result.events, runPanelState.events),
    };
    postRunPanelState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

async function reapplyCachedRunParams(): Promise<void> {
  for (const param of runPanelState.params) {
    if (param.value === null) {
      continue;
    }
    queueRunParamSend(param.name, param.value);
  }
}

function reapplyCachedRunBuffers(): void {
  for (const buffer of runPanelState.buffers) {
    if (!buffer.loadedPath) {
      continue;
    }
    void bindRunBufferFile(buffer.name, buffer.loadedPath, { silent: true });
  }
}

function clearRunParamDisrun(): void {
}

function updateRunParamState(
  name: string,
  update: (param: RunParamState) => RunParamState,
): RunParamState | undefined {
  let nextParam: RunParamState | undefined;
  runPanelState = {
    ...runPanelState,
    params: runPanelState.params.map((param) => {
      if (param.name !== name) {
        return param;
      }
      nextParam = update(param);
      return nextParam;
    }),
  };
  return nextParam;
}

function initialParamValue(param: Pick<RunParamPayload, "type" | "value" | "default" | "rangeMin">): RunScalarValue {
  if (param.type === "bool") {
    if (param.value !== null && param.value !== undefined) {
      return param.value !== 0;
    }
    if (param.default !== null && param.default !== undefined) {
      return param.default !== 0;
    }
    return false;
  }
  if (param.value !== null && param.value !== undefined) {
    return param.value;
  }
  if (param.default !== null && param.default !== undefined) {
    return param.default;
  }
  if (param.rangeMin !== null && param.rangeMin !== undefined) {
    return param.rangeMin;
  }
  return 0;
}

function declaredParamDefaultValue(
  param: Pick<RunParamPayload, "type" | "default" | "rangeMin">,
): RunScalarValue {
  if (param.type === "bool") {
    if (param.default !== null && param.default !== undefined) {
      return param.default !== 0;
    }
    return false;
  }
  if (param.default !== null && param.default !== undefined) {
    return param.default;
  }
  if (param.rangeMin !== null && param.rangeMin !== undefined) {
    return param.rangeMin;
  }
  return 0;
}

function initialEventArgValue(
  arg: Pick<RunEventArgPayload, "type" | "default" | "value">,
): RunScalarValue {
  if (arg.default !== null && arg.default !== undefined) {
    if (arg.type === "bool") {
      return Boolean(arg.default);
    }
    const defaultValue = Number(arg.default);
    return Number.isFinite(defaultValue) ? defaultValue : 0;
  }
  if (arg.type === "bool") {
    if (arg.value !== null && arg.value !== undefined) {
      return arg.value !== 0;
    }
    return false;
  }
  if (arg.value !== null && arg.value !== undefined) {
    return arg.value;
  }
  return 0;
}

function runParamDefaultValue(param: RunParamState): RunScalarValue {
  return declaredParamDefaultValue(param);
}

function queueRunParamSend(name: string, value: RunScalarValue): void {
  if (value === null || !runPanelState.connected) {
    return;
  }
  sendRunControlNotification("setParam", { name, value });
}

function describeRunBufferChannels(buffer: RunBufferPayload): string {
  switch (buffer.channelsKind) {
    case "mono":
      return "mono";
    case "static":
      return `${buffer.channelsStatic ?? 0}-channel`;
    case "dynamic":
      return "dynamic channels";
    default:
      return "unknown";
  }
}

function applyRunParamChange(name: string, value: RunScalarValue): void {
  if (value === null) {
    return;
  }
  const param = updateRunParamState(name, (current) => ({
    ...current,
    value,
  }));
  if (!param) {
    return;
  }

  if (!runPanelState.connected) {
    return;
  }
  queueRunParamSend(name, value);
}

function updateRunEventState(
  name: string,
  update: (event: RunEventState) => RunEventState,
): RunEventState | undefined {
  let nextEvent: RunEventState | undefined;
  runPanelState = {
    ...runPanelState,
    events: runPanelState.events.map((event) => {
      if (event.name !== name) {
        return event;
      }
      nextEvent = update(event);
      return nextEvent;
    }),
  };
  return nextEvent;
}

async function triggerRunEvent(
  name: string,
  values: RunScalarValue[],
): Promise<void> {
  const event = updateRunEventState(name, (current) => ({
    ...current,
    args: current.args.map((arg, index) => ({
      ...arg,
      value: values[index] ?? arg.value,
    })),
  }));
  if (!event) {
    return;
  }
  postRunPanelState();

  if (!runPanelState.connected) {
    return;
  }

  try {
    await sendRunControlRequest("triggerEvent", {
      name,
      values: event.args.map((arg) => arg.value),
    });
    runPanelState = {
      ...runPanelState,
      error: undefined,
    };
    postRunPanelState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

function resetRunParams(): void {
  clearRunParamDisrun();
  runPanelState = {
    ...runPanelState,
    error: undefined,
    params: runPanelState.params.map((param) => ({
      ...param,
      value: runParamDefaultValue(param),
    })),
    events: runPanelState.events.map((event) => ({
      ...event,
      args: event.args.map((arg) => ({
        ...arg,
        value: initialEventArgValue(arg),
      })),
    })),
  };
  postRunPanelState();

  if (!runPanelState.connected) {
    return;
  }

  for (const param of runPanelState.params) {
    queueRunParamSend(param.name, param.value);
  }
}

async function bindRunBufferFile(
  name: string,
  filePath: string,
  options?: { silent?: boolean },
): Promise<void> {
  try {
    await sendRunControlRequest("bindBufferWav", { name, path: filePath });
    runPanelState = {
      ...runPanelState,
      error: undefined,
      buffers: runPanelState.buffers.map((buffer) =>
        buffer.name === name
          ? {
              ...buffer,
              loadedPath: filePath,
            }
          : buffer,
      ),
    };
    postRunPanelState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
    if (!options?.silent) {
      void vscode.window.showErrorMessage(`Failed to bind run buffer '${name}': ${message}`);
    }
  }
}

async function clearRunBuffer(name: string): Promise<void> {
  try {
    await sendRunControlRequest("clearBuffer", { name });
    runPanelState = {
      ...runPanelState,
      error: undefined,
      buffers: runPanelState.buffers.map((buffer) =>
        buffer.name === name
          ? {
              ...buffer,
              loadedPath: null,
            }
          : buffer,
      ),
    };
    postRunPanelState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

async function chooseRunBufferFile(name: string): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: `Bind '${name}' buffer`,
    filters: {
      "Wave Audio": ["wav"],
    },
  });
  const filePath = picked?.[0]?.fsPath;
  if (!filePath) {
    return;
  }
  await bindRunBufferFile(name, filePath);
}

function clearRunPanelMemory(): void {
  clearRunParamDisrun();
  runPanelState = {
    ...runPanelState,
    buffers: [],
    events: [],
    params: [],
    inputDevices: [],
    outputDevices: [],
    currentInputDevice: null,
    currentOutputDevice: null,
  };
}

function normalizeDeviceSelection(name: string | null | undefined): string | null {
  if (typeof name !== "string") {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function updateRunDeviceSelection(
  kind: "input" | "output",
  name: string | null | undefined,
): Promise<void> {
  const next = normalizeDeviceSelection(name);
  runPanelState = {
    ...runPanelState,
    currentInputDevice: kind === "input" ? next : runPanelState.currentInputDevice,
    currentOutputDevice: kind === "output" ? next : runPanelState.currentOutputDevice,
    error: undefined,
  };
  postRunPanelState();

  if (!runPanelState.running || !runPanelState.path) {
    return;
  }
  await runFile(runPanelState.path, { restart: true });
}

async function refreshRunDevices(): Promise<void> {
  try {
    const result = await sendRunControlRequest<{ inputDevices: string[]; outputDevices: string[] }>("getDevices");
    runPanelState = {
      ...runPanelState,
      inputDevices: result.inputDevices ?? [],
      outputDevices: result.outputDevices ?? [],
      error: undefined,
    };
    postRunPanelState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

function sendRunControlRequest<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!runControlSocket || runControlSocket.destroyed) {
      reject(new Error("Run control connection is not available."));
      return;
    }
    const id = ++runControlRequestId;
    pendingRunRequests.set(id, { resolve, reject });
    const request = JSON.stringify({
      id,
      command,
      ...payload,
    });
    runControlSocket.write(`${request}\n`, (error?: Error | null) => {
      if (!error) {
        return;
      }
      pendingRunRequests.delete(id);
      reject(error);
    });
  });
}

function sendRunControlNotification(command: string, payload?: Record<string, unknown>): void {
  if (!runControlSocket || runControlSocket.destroyed) {
    return;
  }
  const request = JSON.stringify({
    command,
    ...payload,
  });
  runControlSocket.write(`${request}\n`);
}

function ensureRunPanel(): void {
  if (runPanel) {
    postRunPanelState();
    return;
  }

  runPanel = vscode.window.createWebviewPanel(
    "ondaRun",
    "Onda Run",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  runPanelReady = false;
  runPanel.onDidDispose(() => {
    stopScopePolling();
    runPanelReady = false;
    runPanel = undefined;
    void stopFile({ silent: true });
    clearRunPanelMemory();
  });
  runPanel.webview.onDidReceiveMessage(async (message: unknown) => {
    const payload = message as {
      type?: string;
      path?: string;
      name?: string | null;
      value?: RunScalarValue;
      values?: RunScalarValue[];
      filePath?: string;
    };
    switch (payload.type) {
      case "webviewReady":
        runPanelReady = true;
        postRunPanelState();
        if (runPanelState.connected) {
          void Promise.all([refreshRunParams(), refreshRunBuffers(), refreshRunEvents()]);
        }
        break;
      case "start":
        await runFile(payload.path ?? runPanelState.path);
        break;
      case "stop":
        await stopFile();
        break;
      case "reset":
        resetRunParams();
        break;
      case "refreshDevices":
        await refreshRunDevices();
        break;
      case "setParam":
        if (typeof payload.name === "string") {
          applyRunParamChange(payload.name, payload.value ?? null);
        }
        break;
      case "triggerEvent":
        if (typeof payload.name === "string") {
          await triggerRunEvent(payload.name, payload.values ?? []);
        }
        break;
      case "setInputDevice":
        await updateRunDeviceSelection("input", payload.name);
        break;
      case "setOutputDevice":
        await updateRunDeviceSelection("output", payload.name);
        break;
      case "chooseBufferFile":
        if (typeof payload.name === "string") {
          await chooseRunBufferFile(payload.name);
        }
        break;
      case "bindBufferFile":
        if (typeof payload.name === "string" && typeof payload.filePath === "string") {
          await bindRunBufferFile(payload.name, payload.filePath);
        }
        break;
      case "clearBuffer":
        if (typeof payload.name === "string") {
          await clearRunBuffer(payload.name);
        }
        break;
      default:
        break;
    }
  });
  runPanel.webview.html = renderSharedRunHtml(runPanel.webview);
  postRunPanelState();
  if (runPanelState.connected) {
    void Promise.all([refreshRunParams(), refreshRunBuffers(), refreshRunEvents()]);
  }
}

function revealRunPanel(): void {
  if (!runPanel) {
    return;
  }
  runPanel.reveal(runPanel.viewColumn);
}

function postRunPanelState(): void {
  if (!runPanel) {
    return;
  }
  void runPanel.webview.postMessage({
    type: "state",
    state: runPanelState,
  });
}

function startScopePolling(): void {
  stopScopePolling();
  scopePollingTimer = setInterval(pollScopeData, SCOPE_POLL_INTERVAL_MS);
}

function stopScopePolling(): void {
  if (scopePollingTimer !== undefined) {
    clearInterval(scopePollingTimer);
    scopePollingTimer = undefined;
  }
  scopePollingInFlight = false;
}

function pollScopeData(): void {
  if (scopePollingInFlight || !runPanelState.connected || !runPanel || !runPanelReady) {
    return;
  }
  scopePollingInFlight = true;
  sendRunControlRequest<{ channels: number; samples: number[] }>("getScopeData", { maxFrames: SCOPE_MAX_FRAMES })
    .then((result) => {
      scopePollingInFlight = false;
      if (runPanel && runPanelReady) {
        void runPanel.webview.postMessage({
          type: "scopeData",
          channels: result.channels,
          samples: result.samples,
        });
      }
    })
    .catch(() => {
      scopePollingInFlight = false;
    });
}

function renderSharedRunHtml(webview: vscode.Webview): string {
  const runTheme = ondaRunThemeSetting();
  const csp = [
    "default-src 'none'",
    "img-src data: https:",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
  ].join("; ");

  // Locate the run HTML.
  // In a packaged extension it lives at <extensionPath>/out/run.html (copied at build time).
  // During development it also exists at <extensionPath>/ui/run/run.html.
  const extRoot = extensionContext?.extensionPath ?? __dirname;
  const candidates = [
    path.join(extRoot, "out", "run.html"),
    path.join(extRoot, "ui", "run", "run.html"),
  ];
  let html: string | undefined;
  let resolvedPath = "";
  for (const candidate of candidates) {
    try {
      html = fs.readFileSync(candidate, "utf-8");
      resolvedPath = candidate;
      break;
    } catch {
      // Try next candidate.
    }
  }
  if (html === undefined) {
    return `<!DOCTYPE html><html><body style="color:#e07a7a;padding:20px;font:14px sans-serif">
      <p>Could not load run UI.</p>
      <p>Searched:<br/>${candidates.map((c) => `<code>${c}</code>`).join("<br/>")}</p>
    </body></html>`;
  }

  // Inject the VS Code host bridge before the page script runs, and add the CSP header.
  const bridgeScript = `<script>window.__hostBridge = { mode: "vscode", theme: "${runTheme}" };</script>`;
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;

  // Insert CSP meta after <head> and bridge script before the main <script>.
  html = html.replace("<head>", `<head>\n    ${cspMeta}`);
  html = html.replace("<script>", `${bridgeScript}\n    <script>`);

  return html;
}

function ondaRunThemeSetting(): "auto" | "dark" | "light" {
  const config = vscode.workspace.getConfiguration("onda");
  const value = config.get<string>("run.theme", "auto");
  if (value === "dark" || value === "light") {
    return value;
  }
  return "auto";
}

function ondaRunHostSetting(): "webview" | "egui" {
  const config = vscode.workspace.getConfiguration("onda");
  const value = config.get<string>("run.host", "webview");
  return value === "egui" ? "egui" : "webview";
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  const { command, extraArgs } = ondaExecutableConfig();
  const args = [...extraArgs, "lsp"];
  const fileWatchers = [
    vscode.workspace.createFileSystemWatcher("**/*.onda"),
    vscode.workspace.createFileSystemWatcher("**/*.on"),
  ];
  context.subscriptions.push(...fileWatchers);

  const serverOptions: ServerOptions = {
    run: {
      command,
      args,
      transport: TransportKind.stdio,
    },
    debug: {
      command,
      args,
      transport: TransportKind.stdio,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "onda" }],
    synchronize: {
      fileEvents: fileWatchers,
    },
    outputChannel: serverOutput,
    traceOutputChannel: serverOutput,
  };

  client = new LanguageClient("onda-lsp", "Onda Language Server", serverOptions, clientOptions);
  await client.start();
}
