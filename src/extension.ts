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
import { initialRunParamValue, normalizeRunParams } from "./runMetadata";

type RunScalarValue = boolean | number | null;
type RunEventValue = RunScalarValue | RunEventValue[];

interface RunParamPayload {
  index: number;
  name: string;
  type: string;
  value: RunScalarValue;
  default: number | null;
  rangeMin: number | null;
  rangeMax: number | null;
  scale: string | null;
  curve: number | null;
  unit: string | null;
  step: number | null;
  stepCount: number | null;
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
  loadedFrames: number | null;
  loadedChannels: number | null;
  loadedSampleRate: number | null;
}

interface RunBufferState extends RunBufferPayload {}

interface RunEventArgPayload {
  index: number;
  name: string;
  type: string;
  default?: RunEventValue;
  value?: RunEventValue;
}

interface RunEventArgState extends RunEventArgPayload {
  value: RunEventValue;
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
  params: unknown;
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
  sampleRateHz: number;
  blockFrames: number;
}

interface PendingControlRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

let client: LanguageClient | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let runProcess: childProcess.ChildProcessWithoutNullStreams | undefined;
let runPath: string | undefined;
let runProcessingRequested = false;
let runOutput: vscode.OutputChannel | undefined;
let projectOutput: vscode.OutputChannel | undefined;
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
const DEFAULT_RUN_SAMPLE_RATE_HZ = 48_000;
const DEFAULT_RUN_BLOCK_FRAMES = 256;
const preservedRunBufferPaths = new Map<string, string>();
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
  sampleRateHz: DEFAULT_RUN_SAMPLE_RATE_HZ,
  blockFrames: DEFAULT_RUN_BLOCK_FRAMES,
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  runOutput = vscode.window.createOutputChannel("Onda Run");
  projectOutput = vscode.window.createOutputChannel("Onda Projects");
  serverOutput = vscode.window.createOutputChannel("Onda Language Server");
  context.subscriptions.push(runOutput, projectOutput, serverOutput);

  context.subscriptions.push(
    vscode.commands.registerCommand("onda.restartLanguageServer", async () => {
      await restartClient();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("onda.runFile", async (resource?: vscode.Uri) => {
      await runFile(resource);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("onda.createProject", async (resource?: vscode.Uri) => {
      await createProject(resource);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("onda.saveAsProject", async (resource?: vscode.Uri) => {
      await saveAsProject(resource);
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

async function runFile(
  preferredInput?: string | vscode.Uri,
  options?: { restart?: boolean },
): Promise<void> {
  const fsPath = await resolveRunPath(preferredInput);
  if (!fsPath) {
    return;
  }
  const preserveRunState = runPanelState.path === fsPath;
  if (!preserveRunState) {
    preservedRunBufferPaths.clear();
  }
  const runHost = ondaRunHostSetting();
  const runTheme = ondaRunThemeSetting();
  const { sampleRateHz, blockFrames } = ondaRunAudioSettings();
  const runSettingsChanged =
    runPanelState.sampleRateHz !== sampleRateHz ||
    runPanelState.blockFrames !== blockFrames;

  if (runHost === "webview") {
    ensureRunPanel();
  } else if (runPanel) {
    runPanel.dispose();
  }
  if (runProcess && runPath === fsPath && !options?.restart && !runSettingsChanged) {
    if (runHost === "webview") {
      revealRunPanel();
      if (runPanelState.connected && !runProcessingRequested) {
        await playRunProcessing();
      }
    }
    return;
  }

  const preservedParams =
    preserveRunState ? runPanelState.params : [];
  const preservedEvents =
    preserveRunState ? runPanelState.events : [];
  runPanelState = {
    running: false,
    connected: false,
    path: fsPath,
    status: `Starting ${path.basename(fsPath)}...`,
    error: undefined,
    outputChannels: preserveRunState ? runPanelState.outputChannels : 0,
    buffers: preserveRunState ? runPanelState.buffers : [],
    events: preservedEvents,
    params: preservedParams,
    inputDevices: runPanelState.inputDevices,
    outputDevices: runPanelState.outputDevices,
    currentInputDevice: runPanelState.currentInputDevice,
    currentOutputDevice: runPanelState.currentOutputDevice,
    sampleRateHz,
    blockFrames,
  };
  postRunPanelState();

  await stopFile({ silent: true, preservePath: fsPath });
  runProcessingRequested = true;

  const { command, extraArgs } = ondaExecutableConfig();
  const args =
    runHost === "egui"
      ? [...extraArgs, "run", fsPath, "--theme", runTheme]
      : [...extraArgs, "run", "play", fsPath, "--forever", "--control-json"];
  args.push(
    "--sample-rate",
    runPanelState.sampleRateHz.toString(),
    "--block-size",
    runPanelState.blockFrames.toString(),
  );
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

async function playRunProcessing(): Promise<void> {
  await setRunProcessing(true);
}

async function pauseRunProcessing(): Promise<void> {
  await setRunProcessing(false);
}

async function setRunProcessing(playing: boolean): Promise<void> {
  if (!runPanelState.connected || !runControlSocket || runControlSocket.destroyed) {
    return;
  }
  try {
    await sendRunControlRequest(playing ? "play" : "pause");
    runProcessingRequested = playing;
    runPanelState = {
      ...runPanelState,
      ...runProcessingState(),
      error: undefined,
    };
    if (runPanelState.running) {
      startScopePolling();
    } else {
      stopScopePolling();
    }
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

async function stopFile(options?: { silent?: boolean; preservePath?: string }): Promise<void> {
  if (!runProcess) {
    runProcessingRequested = false;
    if (!options?.silent) {
      void vscode.window.showInformationMessage("No Onda run is currently running.");
    }
    runPanelState = {
      ...runPanelState,
      connected: false,
      ...runProcessingState(),
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
    connected: false,
    path: options?.preservePath ?? runningPath,
    ...runProcessingState(),
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
  runProcessingRequested = false;
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

async function resolveRunPath(
  preferredInput?: string | vscode.Uri,
): Promise<string | undefined> {
  const uri = typeof preferredInput === "string"
    ? vscode.Uri.file(preferredInput)
    : preferredInput ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || !isOndaRunInput(uri)) {
    void vscode.window.showErrorMessage("Open an Onda source or .ondaproject file to run.");
    return undefined;
  }
  if (uri.scheme !== "file") {
    void vscode.window.showErrorMessage("Onda playback requires an input saved on disk.");
    return undefined;
  }
  if (!await saveOpenDocument(uri, "Onda input must be saved before playback starts.")) {
    return undefined;
  }
  return uri.fsPath;
}

function isOndaRunInput(uri: vscode.Uri): boolean {
  return isOndaSourcePath(uri.fsPath) || isOndaProjectPath(uri.fsPath);
}

function isOndaSourcePath(fsPath: string): boolean {
  const extension = path.extname(fsPath).toLowerCase();
  return extension === ".onda" || extension === ".on";
}

function isOndaProjectPath(fsPath: string): boolean {
  return path.extname(fsPath).toLowerCase() === ".ondaproject";
}

async function saveOpenDocument(uri: vscode.Uri, failureMessage: string): Promise<boolean> {
  const document = vscode.workspace.textDocuments.find((candidate) =>
    candidate.uri.scheme === "file" && path.resolve(candidate.uri.fsPath) === path.resolve(uri.fsPath)
  );
  if (!document?.isDirty) {
    return true;
  }
  if (await document.save()) {
    return true;
  }
  void vscode.window.showErrorMessage(failureMessage);
  return false;
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

async function createProject(resource?: vscode.Uri): Promise<void> {
  const activeSource = activeOndaSourceUri();
  let source: vscode.Uri | undefined;
  if (activeSource) {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "From active source",
          description: path.basename(activeSource.fsPath),
          source: activeSource,
        },
        {
          label: "Empty project",
          description: "Create code/main.onda and an assets directory",
          source: undefined,
        },
      ],
      {
        title: "Create Onda Project",
        placeHolder: "Choose how to initialize the project",
      },
    );
    if (!choice) {
      return;
    }
    source = choice.source;
  }

  if (
    source
    && !await saveOpenDocument(source, "Save the active source before creating a project.")
  ) {
    return;
  }
  const defaultName = source
    ? path.basename(source.fsPath, path.extname(source.fsPath))
    : "onda-project";
  const destination = await chooseProjectDestination(resource ?? source, defaultName, "Create");
  if (!destination) {
    return;
  }

  const args = ["project", destination.fsPath];
  if (source) {
    args.push("--from", source.fsPath);
  }
  if (!await executeProjectCommand(
    args,
    path.dirname(destination.fsPath),
    "Creating Onda project…",
  )) {
    return;
  }
  await offerToOpenProject(destination, "Created");
}

async function saveAsProject(resource?: vscode.Uri): Promise<void> {
  const source = projectSourceUri(resource);
  if (!source) {
    void vscode.window.showErrorMessage(
      "Open an Onda source file, or start a source in Onda Run, before saving it as a project.",
    );
    return;
  }
  if (!await saveOpenDocument(
    source,
    "Save the Onda source before exporting a project.",
  )) {
    return;
  }

  const defaultName = `${path.basename(source.fsPath, path.extname(source.fsPath))}-project`;
  const destination = await chooseProjectDestination(source, defaultName, "Save");
  if (!destination) {
    return;
  }

  const args = ["project", destination.fsPath, "--from", source.fsPath];
  if (samePath(runPanelState.path, source.fsPath)) {
    for (const buffer of runPanelState.buffers) {
      if (buffer.loadedPath) {
        args.push("--buffer", `${buffer.name}=${buffer.loadedPath}`);
      }
    }
  }
  if (!await executeProjectCommand(
    args,
    path.dirname(destination.fsPath),
    "Saving Onda project…",
  )) {
    return;
  }
  await offerToOpenProject(destination, "Saved");
}

function activeOndaSourceUri(): vscode.Uri | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" && isOndaSourcePath(uri.fsPath) ? uri : undefined;
}

function projectSourceUri(resource?: vscode.Uri): vscode.Uri | undefined {
  if (resource?.scheme === "file" && isOndaSourcePath(resource.fsPath)) {
    return resource;
  }
  const active = activeOndaSourceUri();
  if (active) {
    return active;
  }
  return runPanelState.path && isOndaSourcePath(runPanelState.path)
    ? vscode.Uri.file(runPanelState.path)
    : undefined;
}

async function chooseProjectDestination(
  context: vscode.Uri | undefined,
  defaultName: string,
  action: "Create" | "Save",
): Promise<vscode.Uri | undefined> {
  const parent = await vscode.window.showOpenDialog({
    title: `${action} Onda Project: Select Parent Folder`,
    defaultUri: defaultProjectParent(context),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select Parent Folder",
  });
  if (!parent?.[0]) {
    return undefined;
  }
  const name = await vscode.window.showInputBox({
    title: `${action} Onda Project`,
    prompt: "Project folder name",
    value: defaultName,
    valueSelection: [0, defaultName.length],
    validateInput: validateProjectName,
  });
  return name === undefined
    ? undefined
    : vscode.Uri.joinPath(parent[0], name.normalize("NFC"));
}

function defaultProjectParent(context?: vscode.Uri): vscode.Uri | undefined {
  if (context?.scheme === "file") {
    try {
      if (fs.statSync(context.fsPath).isDirectory()) {
        return context;
      }
    } catch {
      // Fall back to the containing directory for a not-yet-created path.
    }
    return vscode.Uri.file(path.dirname(context.fsPath));
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function validateProjectName(value: string): string | undefined {
  const name = value.normalize("NFC");
  if (name.length === 0) {
    return "Enter a project name.";
  }
  if (Buffer.byteLength(name, "utf8") > 255) {
    return "The project name must be at most 255 UTF-8 bytes.";
  }
  if (
    /[<>:"|?*\\/\u0000-\u001f]/.test(name)
    || name === "."
    || name === ".."
  ) {
    return "Use a single portable folder name without slashes or control characters.";
  }
  if (/[. ]$/.test(name)) {
    return "The project name cannot end with a dot or space.";
  }
  const stem = name.split(".", 1)[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    return "That project name is reserved on Windows.";
  }
  return undefined;
}

function samePath(left: string | undefined, right: string): boolean {
  return left !== undefined && path.resolve(left) === path.resolve(right);
}

async function executeProjectCommand(
  commandArgs: string[],
  cwd: string,
  title: string,
): Promise<boolean> {
  const { command, extraArgs } = ondaExecutableConfig();
  const args = [...extraArgs, ...commandArgs];
  projectOutput?.appendLine(`$ ${command} ${args.map(shellQuote).join(" ")}`);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () => spawnProjectCommand(command, args, cwd),
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    projectOutput?.show(true);
    void vscode.window.showErrorMessage(`Onda project command failed: ${message}`);
    return false;
  }
}

function spawnProjectCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      stdio: "pipe",
      windowsHide: true,
    });
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => projectOutput?.append(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      projectOutput?.append(text);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        trimRunErrorText(stderr) ?? (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`),
      ));
    });
  });
}

async function offerToOpenProject(destination: vscode.Uri, verb: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `${verb} Onda project '${path.basename(destination.fsPath)}'.`,
    "Open Project File",
    "Open Folder",
  );
  if (choice === "Open Folder") {
    await vscode.commands.executeCommand("vscode.openFolder", destination, true);
    return;
  }
  if (choice === "Open Project File") {
    const document = await vscode.workspace.openTextDocument(projectManifestUri(destination));
    await vscode.window.showTextDocument(document);
  }
}

function projectManifestUri(destination: vscode.Uri): vscode.Uri {
  const destinationName = path.basename(destination.fsPath);
  const manifestName = isOndaProjectPath(destinationName)
    ? destinationName
    : `${destinationName}.ondaproject`;
  return vscode.Uri.joinPath(destination, manifestName);
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
  return normalizeRunParams(raw);
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
      const buffers = payload.buffers ?? [];
      const params = normalizeRunParams(payload.params) ?? [];
      runPanelState = {
        ...runProcessingState(),
        connected: false,
        path: runPath,
        error: undefined,
        outputChannels: payload.outputChannels ?? 0,
        buffers,
        events: mergeRunEvents(payload.events ?? [], runPanelState.events),
        params: mergeRunParams(params, runPanelState.params),
        inputDevices: payload.inputDevices ?? [],
        outputDevices: payload.outputDevices ?? [],
        currentInputDevice: payload.currentInputDevice ?? null,
        currentOutputDevice: payload.currentOutputDevice ?? null,
        sampleRateHz: runPanelState.sampleRateHz,
        blockFrames: runPanelState.blockFrames,
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
            : initialRunParamValue(param),
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
    next.scale === previous.scale &&
    next.curve === previous.curve &&
    next.unit === previous.unit &&
    next.step === previous.step &&
    next.stepCount === previous.stepCount &&
    next.scalar === previous.scalar
  );
}

function runProcessingState(): Pick<RunPanelState, "running" | "status"> {
  const running = runProcess !== undefined && runProcessingRequested;
  return { running, status: running ? "Running" : "Stopped" };
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
      ...runProcessingState(),
      error: undefined,
    };
    postRunPanelState();
    void Promise.all([
      refreshRunParams(),
      refreshRunBuffers(),
      refreshRunEvents(),
      refreshRunDevices(),
    ]).then(() => {
      reapplyCachedRunParams();
      reapplyCachedRunBuffers();
    });
    if (runPanelState.running) {
      startScopePolling();
    }
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
    const result = await sendRunControlRequest<{ params: unknown }>("getParams");
    const params = normalizeRunParams(result?.params);
    if (!params) {
      return;
    }
    runPanelState = {
      ...runPanelState,
      params: mergeRunParams(params, runPanelState.params),
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
      buffers: result.buffers,
      ...runProcessingState(),
    };
    if (runPanelState.running && runPanelState.connected) {
      startScopePolling();
    } else {
      stopScopePolling();
    }
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
  const declaredBuffers = new Set(runPanelState.buffers.map((buffer) => buffer.name));
  for (const [name, filePath] of preservedRunBufferPaths) {
    if (!declaredBuffers.has(name)) {
      continue;
    }
    void bindRunBufferFile(name, filePath, { silent: true });
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
): RunEventValue {
  if (Array.isArray(arg.default)) {
    return arg.default.map(cloneRunEventValue);
  }
  if (arg.default !== null && arg.default !== undefined) {
    if (arg.type === "bool") {
      return Boolean(arg.default);
    }
    const defaultValue = Number(arg.default);
    return Number.isFinite(defaultValue) ? defaultValue : 0;
  }
  if (arg.type === "bool") {
    if (arg.value !== null && arg.value !== undefined) {
      if (Array.isArray(arg.value)) {
        return arg.value.map(cloneRunEventValue);
      }
      return arg.value !== 0;
    }
    return false;
  }
  if (Array.isArray(arg.value)) {
    return arg.value.map(cloneRunEventValue);
  }
  if (arg.value !== null && arg.value !== undefined) {
    return arg.value;
  }
  return 0;
}

function cloneRunEventValue(value: RunEventValue): RunEventValue {
  return Array.isArray(value) ? value.map(cloneRunEventValue) : value;
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
  values: RunEventValue[],
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
  };
  postRunPanelState();

  if (!runPanelState.connected) {
    return;
  }

  for (const param of runPanelState.params) {
    queueRunParamSend(param.name, param.value);
  }
}

function resetRunEventArguments(): void {
  runPanelState = {
    ...runPanelState,
    error: undefined,
    events: runPanelState.events.map((event) => ({
      ...event,
      args: event.args.map((arg) => ({
        ...arg,
        value: initialEventArgValue(arg),
      })),
    })),
  };
  postRunPanelState();
}

async function bindRunBufferFile(
  name: string,
  filePath: string,
  options?: { silent?: boolean },
): Promise<void> {
  try {
    await sendRunControlRequest("bindBufferWav", { name, path: filePath });
    preservedRunBufferPaths.set(name, filePath);
    runPanelState = {
      ...runPanelState,
      error: undefined,
    };
    await refreshRunBuffers();
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
    preservedRunBufferPaths.delete(name);
    runPanelState = {
      ...runPanelState,
      error: undefined,
    };
    await refreshRunBuffers();
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
      "Onda buffer assets": ["wav", "ondabuffer"],
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
  preservedRunBufferPaths.clear();
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
  if (!runPanelState.connected || !runControlSocket || runControlSocket.destroyed) {
    return;
  }
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
      values?: RunEventValue[];
      filePath?: string;
    };
    switch (payload.type) {
      case "webviewReady":
        runPanelReady = true;
        postRunPanelState();
        if (runPanelState.connected) {
          void Promise.all([
            refreshRunParams(),
            refreshRunBuffers(),
            refreshRunEvents(),
            refreshRunDevices(),
          ]);
        }
        break;
      case "start":
        if (runProcess && runPanelState.connected) {
          await playRunProcessing();
        } else {
          await runFile(payload.path ?? runPanelState.path);
        }
        break;
      case "stop":
        await pauseRunProcessing();
        break;
      case "resetParams":
        resetRunParams();
        break;
      case "resetEventArguments":
        resetRunEventArguments();
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
      case "saveProjectAs":
        await saveAsProject(
          runPanelState.path ? vscode.Uri.file(runPanelState.path) : undefined,
        );
        break;
      default:
        break;
    }
  });
  runPanel.webview.html = renderSharedRunHtml(runPanel.webview);
  postRunPanelState();
  if (runPanelState.connected) {
    void Promise.all([
      refreshRunParams(),
      refreshRunBuffers(),
      refreshRunEvents(),
      refreshRunDevices(),
    ]);
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
    state: {
      ...runPanelState,
      supportsSourceSelection: false,
      supportsProjectExport: Boolean(
        runPanelState.path && isOndaSourcePath(runPanelState.path),
      ),
      canExportProject: Boolean(
        runPanelState.path && isOndaSourcePath(runPanelState.path),
      ),
      supportsTransport: true,
      supportsDeviceSelection: true,
      supportsRunSettings: false,
      supportsScope: true,
    },
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

  const paramControlUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(path.dirname(resolvedPath), "param-control.js")),
  );
  html = html.replace("./param-control.js", paramControlUri.toString());

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

function ondaRunAudioSettings(): { sampleRateHz: number; blockFrames: number } {
  const config = vscode.workspace.getConfiguration("onda");
  return {
    sampleRateHz: positiveIntegerSetting(
      config,
      "run.sampleRate",
      DEFAULT_RUN_SAMPLE_RATE_HZ,
    ),
    blockFrames: positiveIntegerSetting(
      config,
      "run.blockSize",
      DEFAULT_RUN_BLOCK_FRAMES,
    ),
  };
}

function positiveIntegerSetting(
  config: vscode.WorkspaceConfiguration,
  name: string,
  fallback: number,
): number {
  const value = config.get<number>(name, fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
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
