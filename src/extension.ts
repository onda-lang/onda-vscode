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
import {
  applyRunOutputNotification,
  clearRunLogState,
  initialRunLogState,
  RunDelegateMetadata,
  RunLogState,
} from "./runLog";
import {
  RunProcessConfiguration,
  sameRunProcessConfiguration,
} from "./runConfiguration";
import { describeOndaExecutableError } from "./executableError";
import { OndaCompilerSource, resolveOndaExecutable } from "./ondaExecutable";
import { mergeRunDependencies, normalizeRunPath, parseRunSourceGraph, RunSourceGraph } from "./runDependencies";
import { RunFileWatcher } from "./runFileWatcher";
import {
  COMPUTER_KEYBOARD_MIDI_INPUT,
  NO_MIDI_CAPABILITIES,
  normalizeMidiInputDevices,
  RunMidiCapabilities,
  runMidiNoteEvent,
} from "./runMidi";

type RunScalarValue = boolean | number | null;
type RunEventValue =
  | boolean
  | number
  | string
  | null
  | RunEventValue[]
  | { [key: string]: RunEventValue };

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
  waveform?: {
    minValue: number;
    maxValue: number;
    minimums: number[];
    maximums: number[];
  } | null;
}

interface RunBufferState extends RunBufferPayload {}

interface RunEventArgPayload {
  index: number;
  name: string;
  type: string;
  default?: RunEventValue;
  value?: RunEventValue;
  shape?: unknown;
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
  sources?: RunSourceGraph;
  path: string;
  port: number;
  params: unknown;
  buffers: RunBufferPayload[];
  events: RunEventPayload[];
  delegates: RunDelegateMetadata[];
  midi?: Partial<RunMidiCapabilities>;
  outputChannels: number;
  inputDevices: string[];
  outputDevices: string[];
  midiInputDevices?: string[];
  currentInputDevice: string | null;
  currentOutputDevice: string | null;
  currentMidiInputDevice?: string | null;
}

interface RunStoppedMetadata {
  sources?: RunSourceGraph;
  params?: unknown;
  buffers?: RunBufferPayload[];
  events?: RunEventPayload[];
  delegates?: RunDelegateMetadata[];
  midi?: RunMidiCapabilities;
  outputChannels?: number;
  output_channels?: number;
}

interface RunPanelState extends RunLogState {
  running: boolean;
  connected: boolean;
  path?: string;
  status: string;
  error?: string;
  outputChannels: number;
  buffers: RunBufferState[];
  events: RunEventState[];
  delegates: RunDelegateMetadata[];
  params: RunParamState[];
  midi: RunMidiCapabilities;
  inputDevices: string[];
  outputDevices: string[];
  midiInputDevices: string[];
  currentInputDevice: string | null;
  currentOutputDevice: string | null;
  currentMidiInputDevice: string | null;
  sampleRateHz: number;
  blockSamples: number;
  fastMath: boolean;
  paramSmoothingMs: number;
}

interface PendingControlRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

let client: LanguageClient | undefined;
let languageFileWatchers: vscode.FileSystemWatcher[] = [];
let clientRestart: Promise<void> = Promise.resolve();
let extensionDeactivated = false;
let extensionContext: vscode.ExtensionContext | undefined;
let runProcess: childProcess.ChildProcessWithoutNullStreams | undefined;
let runPath: string | undefined;
let activeRunConfiguration: RunProcessConfiguration | undefined;
let runAudioOverrides: { sampleRateHz?: number; blockFrames?: number } = {};
let runProcessingRequested = false;
let runRequestId = 0;
let runTransportUpdateId = 0;
const runInputSaves = new Map<string, number>();
let runSourceFiles = new Set<string>();
let runFileWatcher: RunFileWatcher | undefined;
let runOutput: vscode.OutputChannel | undefined;
let runFailureMessage: vscode.Disposable | undefined;
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
let scopePollingRequested = false;
let scopePollingEpoch = 0;
let scopeCaptureSocket: net.Socket | undefined;
let scopeCaptureMode: "off" | "meter" | "waveform" = "off";
let scopeColumns = 348;
let scopeViewVisible = false;
let scopeMeterVisible = false;
let runSchemaReady = false;
const SCOPE_MAX_FRAMES = 1024;
const SCOPE_POLL_INTERVAL_MS = 1000 / 30;
const RUN_FORCE_KILL_DELAY_MS = 1500;
const DEFAULT_RUN_SAMPLE_RATE_HZ = 48_000;
const DEFAULT_RUN_BLOCK_FRAMES = 512;
const DEFAULT_PARAM_SMOOTHING_MS = 30;
// Match Rust's usize::MAX converted to f64 on the local host.
const RUN_SAMPLE_COUNTER_MAX = Number(
  process.arch === "ia32" || process.arch === "arm" ? 0xffff_ffffn : 0xffff_ffff_ffff_ffffn,
);
let paramSmoothingUpdateId = 0;
let confirmedParamSmoothing = { id: 0, milliseconds: DEFAULT_PARAM_SMOOTHING_MS };
const preservedRunBufferBindings = new Map<string, string | null>();
let runPanelState: RunPanelState = {
  ...initialRunLogState(),
  running: false,
  connected: false,
  status: "Stopped",
  outputChannels: 0,
  buffers: [],
  events: [],
  delegates: [],
  params: [],
  midi: NO_MIDI_CAPABILITIES,
  inputDevices: [],
  outputDevices: [],
  midiInputDevices: [],
  currentInputDevice: null,
  currentOutputDevice: null,
  currentMidiInputDevice: COMPUTER_KEYBOARD_MIDI_INPUT,
  sampleRateHz: DEFAULT_RUN_SAMPLE_RATE_HZ,
  blockSamples: DEFAULT_RUN_BLOCK_FRAMES,
  fastMath: false,
  paramSmoothingMs: DEFAULT_PARAM_SMOOTHING_MS,
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  extensionDeactivated = false;
  runOutput = vscode.window.createOutputChannel("Onda Run");
  projectOutput = vscode.window.createOutputChannel("Onda Projects");
  serverOutput = vscode.window.createOutputChannel("Onda Language Server");
  languageFileWatchers = [
    vscode.workspace.createFileSystemWatcher("**/*.onda"),
    vscode.workspace.createFileSystemWatcher("**/*.on"),
  ];
  context.subscriptions.push(runOutput, projectOutput, serverOutput, ...languageFileWatchers);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration("onda.run.theme")) postRunPanelState();
    if (event.affectsConfiguration("onda.run.sampleRate")) delete runAudioOverrides.sampleRateHz;
    if (event.affectsConfiguration("onda.run.blockSize")) delete runAudioOverrides.blockFrames;
    if (["onda.compiler.source", "onda.server.path", "onda.server.args"]
      .some((setting) => event.affectsConfiguration(setting))) {
      await restartClient();
    }
  }));

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
    vscode.commands.registerCommand("onda.runFileWithFastMath", async (resource?: vscode.Uri) => {
      await runFile(resource, { fastMath: true });
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

  await restartClient();
}

export async function deactivate(): Promise<void> {
  extensionDeactivated = true;
  await clientRestart;
  await stopClient();
}

async function stopClient(): Promise<void> {
  disposeRunFileWatcher();
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

function restartClient(): Promise<void> {
  const restart = clientRestart.then(async () => {
    if (extensionDeactivated) return;
    await stopClient();
    if (extensionDeactivated) return;
    if (!extensionContext) {
      throw new Error("Onda extension context is not initialized");
    }
    await startClient();
  });
  clientRestart = restart.catch(() => {});
  return restart;
}

async function runFile(
  preferredInput?: string | vscode.Uri,
  options?: { restart?: boolean; fastMath?: boolean; preserveFocus?: boolean; saveInput?: boolean },
): Promise<void> {
  const requestId = ++runRequestId;
  const input = await resolveRunPath(preferredInput, options?.saveInput ?? true);
  if (!input || requestId !== runRequestId) {
    return;
  }
  const { fsPath, saved } = input;
  const preserveRunState = runPanelState.path === fsPath;
  if (!preserveRunState) {
    disposeRunFileWatcher();
    preservedRunBufferBindings.clear();
    runSourceFiles = new Set([path.resolve(fsPath)]);
  }
  const { sampleRateHz, blockFrames, args: audioArgs } = ondaRunAudioSettings();
  const fastMath = options?.fastMath ?? false;
  const preserveFocus = options?.preserveFocus ?? false;
  const desiredRunConfiguration: RunProcessConfiguration = {
    sampleRateHz,
    blockFrames,
    fastMath,
    inputDevice: runPanelState.currentInputDevice,
    outputDevice: runPanelState.currentOutputDevice,
    midiInputDevice: runPanelState.currentMidiInputDevice,
  };

  ensureRunPanel(preserveFocus);
  if (
    runProcess &&
    runPath === fsPath &&
    !options?.restart && !saved &&
    sameRunProcessConfiguration(activeRunConfiguration, desiredRunConfiguration)
  ) {
    revealRunPanel(preserveFocus);
    if (runPanelState.connected && !runProcessingRequested) {
      await playRunProcessing();
    }
    return;
  }

  await stopFile({ silent: true, preservePath: fsPath, preservePendingStart: true });
  if (requestId !== runRequestId) return;

  const preservedParams =
    preserveRunState ? runPanelState.params : [];
  const preservedEvents =
    preserveRunState ? runPanelState.events : [];
  runProcessingRequested = true;
  runSchemaReady = false;
  runPanelState = {
    ...initialRunLogState(),
    running: false,
    connected: false,
    path: fsPath,
    status: `Compiling ${path.basename(fsPath)}...`,
    error: undefined,
    outputChannels: preserveRunState ? runPanelState.outputChannels : 0,
    buffers: preserveRunState ? runPanelState.buffers : [],
    events: preservedEvents,
    delegates: [],
    params: preservedParams,
    midi: preserveRunState
      ? runPanelState.midi
      : NO_MIDI_CAPABILITIES,
    inputDevices: runPanelState.inputDevices,
    outputDevices: runPanelState.outputDevices,
    midiInputDevices: runPanelState.midiInputDevices,
    currentInputDevice: runPanelState.currentInputDevice,
    currentOutputDevice: runPanelState.currentOutputDevice,
    currentMidiInputDevice: runPanelState.currentMidiInputDevice,
    sampleRateHz,
    blockSamples: blockFrames,
    fastMath,
    paramSmoothingMs: runPanelState.paramSmoothingMs,
  };
  postRunPanelState();

  confirmedParamSmoothing = {
    id: ++paramSmoothingUpdateId,
    milliseconds: runPanelState.paramSmoothingMs,
  };

  const { command, extraArgs, source } = ondaExecutableConfig();
  const args = [...extraArgs, "run", "play", fsPath, "--forever", "--control-json", "--report-sources"];
  args.push(
    ...audioArgs,
    "--param-smoothing-ms",
    runPanelState.paramSmoothingMs.toString(),
  );
  if (fastMath) {
    args.push("--fast-math");
  }
  if (runPanelState.currentInputDevice) {
    args.push("--input-device", runPanelState.currentInputDevice);
  }
  if (runPanelState.currentOutputDevice) {
    args.push("--output-device", runPanelState.currentOutputDevice);
  }
  if (
    runPanelState.currentMidiInputDevice &&
    runPanelState.currentMidiInputDevice !== COMPUTER_KEYBOARD_MIDI_INPUT
  ) {
    args.push("--midi-input-device", runPanelState.currentMidiInputDevice);
  }
  const cwd = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))?.uri.fsPath ?? path.dirname(fsPath);
  updateRunFileWatcher();
  runFileWatcher?.acknowledge();
  const child = childProcess.spawn(command, args, {
    cwd,
    stdio: "pipe",
    detached: process.platform !== "win32",
  });

  runProcess = child;
  runPath = fsPath;
  activeRunConfiguration = desiredRunConfiguration;
  runStdoutBuffer = "";
  let runStderrBuffer = "";

  runOutput?.appendLine(`$ ${command} ${args.map(shellQuote).join(" ")}`);
  revealRunPanel(preserveFocus);

  child.stdout.on("data", (chunk: Buffer) => {
    if (runProcess !== child) {
      return;
    }
    handleRunStdout(chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    runStderrBuffer += text;
    runOutput?.append(text);
  });
  child.once("error", (error: Error) => {
    if (runProcess !== child) {
      return;
    }
    const description = describeOndaExecutableError(command, error, source);
    const failedPath = fsPath;
    clearRunRuntimeState({ preservePath: failedPath, preserveProcessingRequested: true });
    runPanelState = {
      ...runPanelState,
      running: false,
      connected: false,
      path: failedPath,
      status: "Failed to start",
      error: description.message,
    };
    postRunPanelState();
    void showOndaCommandError(
      `Failed to start Onda run${failedPath ? ` (${path.basename(failedPath)})` : ""}`,
      command,
      error,
      source,
    );
  });
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    const finishedPath = fsPath;
    clearRunKillTimer(child.pid);
    const expectedStop = child.pid !== undefined && stoppingRunPid === child.pid;
    if (expectedStop) {
      stoppingRunPid = undefined;
    }
    if (runProcess !== child) {
      return;
    }
    const failed = !expectedStop && (signal !== null || code !== 0);
    const exitError = failed ? formatRunExitError(runStderrBuffer, code, signal) : undefined;
    clearRunRuntimeState({ preservePath: finishedPath, preserveProcessingRequested: failed });
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
    runFailureMessage = vscode.window.setStatusBarMessage(
      `$(warning) Onda run stopped${finishedPath ? ` (${path.basename(finishedPath)})` : ""}. See Onda Run for details.`,
      5000,
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
    if (!playing) await stopFile({ silent: true });
    return;
  }
  // Stop also cancels a Run still waiting for its input to be saved.
  if (!playing) ++runRequestId;
  const socket = runControlSocket;
  const requestId = runRequestId;
  const updateId = ++runTransportUpdateId;
  runProcessingRequested = playing;
  try {
    await sendRunControlRequest(playing ? "play" : "pause");
    // Reusing this process for another Run leaves its pending transport valid.
    if (socket !== runControlSocket || updateId !== runTransportUpdateId) return;
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
    if (socket !== runControlSocket || updateId !== runTransportUpdateId) return;
    if (!playing) {
      // Killing a failed pause must not cancel a newer Run still saving its input.
      if (requestId !== runRequestId) return;
      const stopped = stopFile({ silent: true });
      const stopRequestId = runRequestId;
      await stopped;
      if (stopRequestId !== runRequestId) return;
    }
    runProcessingRequested = false;
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      ...runProcessingState(),
      error: message,
    };
    postRunPanelState();
  }
}

async function stopFile(options?: {
  silent?: boolean;
  preservePath?: string;
  preservePendingStart?: boolean;
}): Promise<void> {
  runFailureMessage?.dispose();
  runFailureMessage = undefined;
  if (!options?.preservePendingStart) ++runRequestId;
  ++runTransportUpdateId;
  if (!runProcess) {
    runProcessingRequested = false;
    runSchemaReady = true;
    if (!options?.silent) {
      void vscode.window.showInformationMessage("No Onda run is currently running.");
    }
    runPanelState = {
      ...runPanelState,
      connected: false,
      ...runProcessingState(),
      error: undefined,
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

function clearRunRuntimeState(options?: {
  preservePath?: string;
  preserveProcessingRequested?: boolean;
}): void {
  runSchemaReady = true;
  runProcess = undefined;
  runPath = options?.preservePath;
  activeRunConfiguration = undefined;
  // A failed compile stops the process, but saving a fix should resume playback.
  if (!options?.preserveProcessingRequested) {
    runProcessingRequested = false;
  }
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
  // The watcher queues dependency edits until the explicit Run finishes saving.
  if (document.uri.scheme !== "file" || runInputSaves.size > 0) {
    return;
  }
  const activePath = runPath ?? runPanelState.path;
  if (!activePath) {
    return;
  }
  if (normalizeRunPath(document.uri.fsPath) !== normalizeRunPath(activePath)
    && !runSourceFiles.has(normalizeRunPath(document.uri.fsPath))) {
    return;
  }
  if (runFileWatcher?.isCurrent(document.uri.fsPath)) return;
  await restartRunForSourceChanges();
}

async function restartRunForSourceChanges(): Promise<void> {
  const activePath = runPath ?? runPanelState.path;
  if (!activePath) return;
  if (runProcessingRequested) {
    await runFile(activePath, {
      restart: true, fastMath: runPanelState.fastMath, preserveFocus: true, saveInput: false,
    });
    return;
  }
  await refreshStoppedRunMetadata(activePath);
}

function updateRunFileWatcher(): void {
  if (!runPanel || !runPanelState.path) return;
  runFileWatcher ??= new RunFileWatcher(() => {
    void restartRunForSourceChanges().catch((error) => {
      runOutput?.appendLine(`Failed to reload Onda run: ${String(error)}`);
    });
  }, () => runInputSaves.size > 0, (file, error) => {
    runOutput?.appendLine(`Could not validate Onda source ${file}: ${String(error)}; retrying.`);
  });
  runFileWatcher.update(runSourceFiles);
}

function disposeRunFileWatcher(): void {
  runFileWatcher?.dispose();
  runFileWatcher = undefined;
}

function updateRunDependencies(input: string, graph: unknown): void {
  const parsed = parseRunSourceGraph(graph);
  if (!parsed) return;
  runSourceFiles = mergeRunDependencies(input, runSourceFiles, parsed);
  updateRunFileWatcher();
  if (parsed.contentHashes) void runFileWatcher?.validate(parsed.contentHashes);
}

async function resolveRunPath(
  preferredInput?: string | vscode.Uri,
  saveInput = true,
): Promise<{ fsPath: string; saved: boolean } | undefined> {
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
  // Source-save reloads compile the on-disk input without saving other dirty editors.
  if (!saveInput) return { fsPath: uri.fsPath, saved: false };
  // An explicit Run owns its save and restart; project commands use normal save handling.
  const inputPath = path.resolve(uri.fsPath);
  runInputSaves.set(inputPath, (runInputSaves.get(inputPath) ?? 0) + 1);
  try {
    const result = await saveOpenDocument(uri, "Onda input must be saved before playback starts.");
    return result ? { fsPath: uri.fsPath, saved: result.saved } : undefined;
  } finally {
    const pending = (runInputSaves.get(inputPath) ?? 1) - 1;
    if (pending === 0) runInputSaves.delete(inputPath);
    else runInputSaves.set(inputPath, pending);
  }
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

async function saveOpenDocument(
  uri: vscode.Uri,
  failureMessage: string,
): Promise<{ saved: boolean } | undefined> {
  const inputPath = path.resolve(uri.fsPath);
  const document = vscode.workspace.textDocuments.find((candidate) =>
    candidate.uri.scheme === "file" && path.resolve(candidate.uri.fsPath) === inputPath
  );
  if (!document?.isDirty) return { saved: false };
  if (await document.save()) return { saved: true };
  void vscode.window.showErrorMessage(failureMessage);
  return undefined;
}

function ondaExecutableConfig(): { command: string; extraArgs: string[]; source: OndaCompilerSource } {
  const config = vscode.workspace.getConfiguration("onda");
  const source = config.get<OndaCompilerSource>("compiler.source", "bundled");
  return {
    command: resolveOndaExecutable(
      extensionContext?.extensionPath ?? path.resolve(__dirname, ".."),
      source,
      config.get<string>("server.path"),
    ),
    extraArgs: config.get<string[]>("server.args", []),
    source,
  };
}

const CONFIGURE_EXECUTABLE_ACTION = "Configure Executable";

async function showOndaCommandError(
  context: string,
  command: string,
  error: unknown,
  source: OndaCompilerSource,
): Promise<void> {
  const description = describeOndaExecutableError(command, error, source);
  const message = `${context}: ${description.message}`;
  if (!description.canConfigure) {
    await vscode.window.showErrorMessage(message);
    return;
  }

  const action = await vscode.window.showErrorMessage(message, CONFIGURE_EXECUTABLE_ACTION);
  if (action === CONFIGURE_EXECUTABLE_ACTION) {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      source === "bundled" ? "onda.compiler.source" : "onda.server.path",
    );
  }
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
  const { command, extraArgs, source } = ondaExecutableConfig();
  const args = [...extraArgs, ...commandArgs];
  projectOutput?.appendLine(`$ ${command} ${args.map(shellQuote).join(" ")}`);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () => spawnProjectCommand(command, args, cwd),
    );
    return true;
  } catch (error) {
    projectOutput?.show(true);
    await showOndaCommandError("Onda project command failed", command, error, source);
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
  const requestId = ++runRequestId;
  if (runProcess) {
    await stopFile({ silent: true, preservePath: fsPath, preservePendingStart: true });
    if (requestId !== runRequestId) return;
  }
  const { sampleRateHz, blockFrames } = ondaRunAudioSettings();
  updateRunFileWatcher();
  runFileWatcher?.acknowledge();
  runSchemaReady = false;
  try {
    const result = await loadStoppedRunMetadata(fsPath, (graph) => {
      if (requestId === runRequestId) {
        updateRunDependencies(fsPath, graph);
      }
    });
    if (requestId !== runRequestId) return;
    if (result.sources) updateRunDependencies(fsPath, result.sources);
    runSchemaReady = true;
    const params = normalizeStoppedRunParams(result.params);
    runPanelState = {
      ...runPanelState,
      path: fsPath,
      status: "Stopped",
      sampleRateHz,
      blockSamples: blockFrames,
      error: undefined,
      outputChannels: result.outputChannels ?? result.output_channels ?? runPanelState.outputChannels,
      buffers: result.buffers
        ? mergeStoppedRunBuffers(result.buffers, runPanelState.buffers)
        : runPanelState.buffers,
      events: result.events ? mergeRunEvents(result.events, runPanelState.events) : runPanelState.events,
      delegates: result.delegates ?? runPanelState.delegates,
      midi: result.midi ?? runPanelState.midi,
      params: params
        ? mergeRunParams(params, runPanelState.params)
        : runPanelState.params,
    };
    postRunPanelState();
  } catch (error) {
    if (requestId !== runRequestId) return;
    runSchemaReady = true;
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

function mergeStoppedRunBuffers(
  buffers: RunBufferPayload[],
  existing: RunBufferState[],
): RunBufferState[] {
  return buffers.map((buffer) => {
    const binding = preservedRunBufferBindings.get(buffer.name);
    if (binding === undefined) return buffer;
    const loaded = binding === null ? undefined : existing.find((previous) =>
      previous.name === buffer.name && previous.loadedPath === binding
    );
    return {
      ...buffer,
      loadedPath: binding,
      loadedFrames: loaded?.loadedFrames ?? null,
      loadedChannels: loaded?.loadedChannels ?? null,
      loadedSampleRate: loaded?.loadedSampleRate ?? null,
      waveform: loaded?.waveform ?? null,
    };
  });
}

async function loadStoppedRunMetadata(
  fsPath: string,
  onSources?: (graph: unknown) => void,
): Promise<RunStoppedMetadata> {
  const { command, extraArgs, source } = ondaExecutableConfig();
  const { sampleRateHz, blockFrames } = ondaRunAudioSettings();
  const fastMath = runPanelState.fastMath;
  const paramSmoothingSeconds = runPanelState.paramSmoothingMs / 1000;
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
        let payload: { id?: number; ok?: boolean; result?: RunStoppedMetadata; error?: string };
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
        if (!payload.ok && payload.result?.sources) {
          onSources?.(payload.result.sources);
        }
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
      fail(describeOndaExecutableError(command, error, source).message);
    });

    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      const stderrText = trimRunErrorText(stderrBuffer);
      const reason = stderrText ?? (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
      fail(`daemon metadata refresh exited unexpectedly: ${reason}`);
    });

    void sendRequest("run_sources", { path: fsPath })
      .then((graph) => {
        onSources?.(graph);
        return sendRequest("initialize", {
          sample_rate_hz: sampleRateHz,
          block_samples: blockFrames,
          fast_math: fastMath,
          param_smoothing_seconds: paramSmoothingSeconds,
        });
      })
      .then(() => sendRequest("run_metadata", { path: fsPath }))
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
    const payload = JSON.parse(line) as RunReadyEvent | (RunSourceGraph & { event: "sources" });
    if (payload.event === "sources") {
      if (runPath) updateRunDependencies(runPath, payload);
      return;
    }
    if (payload.event === "ready") {
      if (runPath && payload.sources) updateRunDependencies(runPath, payload.sources);
      const buffers = payload.buffers ?? [];
      const params = normalizeRunParams(payload.params) ?? [];
      runPanelState = {
        ...runPanelState,
        ...runProcessingState(),
        connected: false,
        path: runPath,
        error: undefined,
        outputChannels: payload.outputChannels ?? 0,
        buffers,
        events: mergeRunEvents(payload.events ?? [], runPanelState.events),
        delegates: payload.delegates ?? [],
        params: mergeRunParams(params, runPanelState.params),
        midi: {
          available: payload.midi?.available === true,
          noteOn: payload.midi?.noteOn === true,
          noteOff: payload.midi?.noteOff === true,
        },
        inputDevices: payload.inputDevices ?? [],
        outputDevices: payload.outputDevices ?? [],
        midiInputDevices: normalizeMidiInputDevices(payload.midiInputDevices),
        currentInputDevice: payload.currentInputDevice ?? null,
        currentOutputDevice: payload.currentOutputDevice ?? null,
        currentMidiInputDevice:
          payload.currentMidiInputDevice ??
          (runPanelState.currentMidiInputDevice === COMPUTER_KEYBOARD_MIDI_INPUT
            ? COMPUTER_KEYBOARD_MIDI_INPUT
            : null),
        sampleRateHz: runPanelState.sampleRateHz,
        blockSamples: runPanelState.blockSamples,
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
// The shared UI owns default-value hydration.
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
    const args = event.args ?? [];
    const compatible = previous?.args.length === args.length && args.every((arg, index) => {
      const old = previous.args[index];
      return old.name === arg.name && old.type === arg.type
        && JSON.stringify(old.shape) === JSON.stringify(arg.shape)
        && JSON.stringify(old.default) === JSON.stringify(arg.default);
    });
    return {
      ...event,
      args: args.map((arg, index) => ({
        ...arg,
        value: compatible ? previous.args[index].value : initialEventArgValue(arg),
      })),
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
    if (runControlSocket !== socket) return;
    runPanelState = {
      ...runPanelState,
      connected: true,
      ...runProcessingState(),
      error: undefined,
    };
    postRunPanelState();
    sendRunControlNotification("subscribeDelegates");
    void Promise.all([
      updateRunParamSmoothing(runPanelState.paramSmoothingMs),
      refreshRunParams(),
      refreshRunBuffers(),
      refreshRunEvents(),
      refreshRunDevices(),
    ]).then(() => {
      if (runControlSocket !== socket) return;
      runSchemaReady = true;
      postRunPanelState();
      reapplyCachedRunParams();
      reapplyCachedRunBuffers();
    });
    if (runPanelState.running) {
      startScopePolling();
    }
  });
  socket.on("data", (chunk: string) => {
    if (runControlSocket !== socket) return;
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
    if (runControlSocket !== socket) return;
    stopScopePolling();
    runPanelState = {
      ...runPanelState,
      connected: false,
      error: error.message,
    };
    postRunPanelState();
  });
  socket.on("close", () => {
    if (runControlSocket !== socket) return;
    runSchemaReady = true;
    stopScopePolling();
    runControlSocket = undefined;
    runControlBuffer = "";
    rejectPendingRunRequests(new Error("Run control connection closed."));
    runPanelState = {
      ...runPanelState,
      connected: false,
    };
    postRunPanelState();
  });
}

function closeRunControlSocket(): void {
  stopScopePolling();
  const socket = runControlSocket;
  runControlSocket = undefined;
  runControlBuffer = "";
  clearRunParamDisrun();
  rejectPendingRunRequests(new Error("Run control session ended."));
  socket?.destroy();
}

function handleRunControlLine(line: string): void {
  const payload = JSON.parse(line) as {
    id?: number;
    ok?: boolean;
    result?: unknown;
    error?: string;
  };
  const logState = applyRunOutputNotification(
    runPanelState,
    payload,
    runPanelState.delegates,
  );
  if (logState) {
    runPanelState = {
      ...runPanelState,
      ...logState,
    };
    postRunPanelState();
    return;
  }
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
  const socket = runControlSocket;
  try {
    const result = await sendRunControlRequest<{ params: unknown }>("getParams");
    if (socket !== runControlSocket) return;
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
    if (socket !== runControlSocket) return;
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

async function refreshRunBuffers(): Promise<void> {
  const socket = runControlSocket;
  try {
    const result = await sendRunControlRequest<{ buffers: RunBufferPayload[] }>("getBuffers");
    if (socket !== runControlSocket) return;
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
    if (socket !== runControlSocket) return;
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

async function refreshRunEvents(): Promise<void> {
  const socket = runControlSocket;
  try {
    const result = await sendRunControlRequest<{ events: RunEventPayload[] }>("getEvents");
    if (socket !== runControlSocket) return;
    if (!result || !Array.isArray(result.events)) {
      return;
    }
    runPanelState = {
      ...runPanelState,
      events: mergeRunEvents(result.events, runPanelState.events),
    };
    postRunPanelState();
  } catch (error) {
    if (socket !== runControlSocket) return;
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
  for (const [name, filePath] of preservedRunBufferBindings) {
    if (!declaredBuffers.has(name)) {
      continue;
    }
    if (filePath === null) void clearRunBuffer(name);
    else void bindRunBufferFile(name, filePath, { silent: true });
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
  if (!/^(?:f32|f64|i32|i64|bool)(?:\[[0-9]*\])?$/.test(arg.type)) {
    return cloneRunEventValue(arg.default ?? arg.value ?? {});
  }
  if (Array.isArray(arg.default)) {
    return arg.default.map(cloneRunEventValue);
  }
  if (arg.default !== null && arg.default !== undefined) {
    if (arg.type === "bool") {
      return Boolean(arg.default);
    }
    if (arg.type === "i64") {
      return String(arg.default);
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
    if (arg.type === "i64") {
      return String(arg.value);
    }
    return arg.value;
  }
  return arg.type === "i64" ? "0" : 0;
}

function cloneRunEventValue(value: RunEventValue): RunEventValue {
  if (Array.isArray(value)) {
    return value.map(cloneRunEventValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneRunEventValue(item)]),
    );
  }
  return value;
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

async function updateRunParamSmoothing(milliseconds: unknown): Promise<void> {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) {
    postRunPanelState();
    return;
  }
  const sampleRateHz = runProcess
    ? runPanelState.sampleRateHz
    : ondaRunAudioSettings().sampleRateHz;
  if (Math.ceil((milliseconds / 1000) * sampleRateHz) >= RUN_SAMPLE_COUNTER_MAX) {
    runPanelState = {
      ...runPanelState,
      error: "Parameter smoothing must fit the host sample counter.",
    };
    postRunPanelState();
    return;
  }
  const updateId = ++paramSmoothingUpdateId;
  const socket = runControlSocket;
  runPanelState = { ...runPanelState, paramSmoothingMs: milliseconds, error: undefined };
  if (!runPanelState.connected) {
    postRunPanelState();
    return;
  }
  try {
    await sendRunControlRequest("setParamSmoothing", { value: milliseconds / 1000 });
    if (socket !== runControlSocket) return;
    if (updateId > confirmedParamSmoothing.id) {
      confirmedParamSmoothing = { id: updateId, milliseconds };
    }
    // Drag updates can overlap; only the latest completion reconciles the view.
    if (updateId !== paramSmoothingUpdateId) return;
  } catch (error) {
    if (socket !== runControlSocket || updateId !== paramSmoothingUpdateId) return;
    runPanelState = {
      ...runPanelState,
      paramSmoothingMs: confirmedParamSmoothing.milliseconds,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  postRunPanelState();
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

  postRunParameterValues([param]);
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
  const socket = runControlSocket;
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
    if (socket !== runControlSocket) return;
    runPanelState = {
      ...runPanelState,
      error: undefined,
    };
    postRunPanelState();
  } catch (error) {
    if (socket !== runControlSocket) return;
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

function postRunParameterValues(params: RunParamState[]): void {
  if (!runPanel || !runPanelReady || !lastPostedRunState || lastPostedRunState.path !== runPanelState.path) {
    postRunPanelState();
    return;
  }
  lastPostedRunState.params = runPanelState.params;
  void runPanel.webview.postMessage({
    type: "parameterValues",
    state: { params: params.map(({ name, value }) => ({ name, value })) },
  });
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
  postRunParameterValues(runPanelState.params);
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
  postRunPanelState({ resetEventArguments: true });
}

async function bindRunBufferFile(
  name: string,
  filePath: string,
  options?: { silent?: boolean },
): Promise<void> {
  await setRunBufferBinding(name, filePath, options);
}

async function clearRunBuffer(name: string): Promise<void> {
  await setRunBufferBinding(name, null, { silent: true });
}

async function setRunBufferBinding(
  name: string,
  filePath: string | null,
  options?: { silent?: boolean },
): Promise<void> {
  if (!runPanelState.connected || !runControlSocket || runControlSocket.destroyed) {
    if (!runPanelState.buffers.some((buffer) => buffer.name === name)) return;
    // Stopped saves close the audio process. Retain edits for the next Play.
    preservedRunBufferBindings.set(name, filePath);
    runPanelState = {
      ...runPanelState,
      buffers: mergeStoppedRunBuffers(runPanelState.buffers, runPanelState.buffers),
      error: undefined,
    };
    postRunPanelState();
    return;
  }
  const socket = runControlSocket;
  try {
    await sendRunControlRequest(
      filePath === null ? "clearBuffer" : "bindBufferWav",
      filePath === null ? { name } : { name, path: filePath },
    );
    if (socket !== runControlSocket) return;
    preservedRunBufferBindings.set(name, filePath);
    runPanelState = {
      ...runPanelState,
      error: undefined,
    };
    await refreshRunBuffers();
  } catch (error) {
    if (socket !== runControlSocket) return;
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

async function chooseRunBufferFile(name: string): Promise<void> {
  const inputPath = runPanelState.path;
  const requestId = runRequestId;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: `Bind '${name}' buffer`,
    filters: {
      "Onda buffer assets": ["wav", "ondabuffer"],
    },
  });
  const filePath = picked?.[0]?.fsPath;
  if (!filePath || requestId !== runRequestId || inputPath !== runPanelState.path) {
    return;
  }
  await bindRunBufferFile(name, filePath);
}

function clearRunPanelMemory(): void {
  disposeRunFileWatcher();
  runPath = undefined;
  runSourceFiles.clear();
  clearRunParamDisrun();
  preservedRunBufferBindings.clear();
  runPanelState = {
    ...runPanelState,
    ...initialRunLogState(),
    path: undefined,
    error: undefined,
    running: false,
    connected: false,
    status: "Stopped",
    outputChannels: 0,
    buffers: [],
    events: [],
    delegates: [],
    params: [],
    midi: NO_MIDI_CAPABILITIES,
    inputDevices: [],
    outputDevices: [],
    midiInputDevices: [],
    currentInputDevice: null,
    currentOutputDevice: null,
    currentMidiInputDevice: COMPUTER_KEYBOARD_MIDI_INPUT,
    fastMath: false,
  };
}

function normalizeDeviceSelection(name: string | null | undefined): string | null {
  if (typeof name !== "string") {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function updateRunSettings(sampleRateHz: unknown, blockSamples: unknown): Promise<void> {
  if (typeof sampleRateHz !== "number" || !Number.isInteger(sampleRateHz)
    || sampleRateHz < 1 || sampleRateHz > 768000
    || typeof blockSamples !== "number" || !Number.isInteger(blockSamples)
    || blockSamples < 1 || blockSamples > 65536) return;
  if (sampleRateHz === runPanelState.sampleRateHz && blockSamples === runPanelState.blockSamples) return;
  runAudioOverrides = { sampleRateHz, blockFrames: blockSamples };
  runPanelState = { ...runPanelState, sampleRateHz, blockSamples };
  if (runPanelState.path) {
    await restartRunForSourceChanges();
  } else {
    postRunPanelState();
  }
}

async function updateRunDeviceSelection(
  kind: "input" | "output" | "midi",
  name: string | null | undefined,
): Promise<void> {
  const next = normalizeDeviceSelection(name);
  runPanelState = {
    ...runPanelState,
    currentInputDevice: kind === "input" ? next : runPanelState.currentInputDevice,
    currentOutputDevice: kind === "output" ? next : runPanelState.currentOutputDevice,
    currentMidiInputDevice: kind === "midi" ? next : runPanelState.currentMidiInputDevice,
    error: undefined,
  };
  postRunPanelState();

  if (!runPanelState.running || !runPanelState.path) {
    return;
  }
  await runFile(runPanelState.path, { restart: true, fastMath: runPanelState.fastMath });
}

async function refreshRunDevices(): Promise<void> {
  const socket = runControlSocket;
  if (!runPanelState.connected || !runControlSocket || runControlSocket.destroyed) {
    return;
  }
  try {
    const result = await sendRunControlRequest<{
      inputDevices: string[];
      outputDevices: string[];
      midiInputDevices?: string[];
    }>("getDevices");
    if (socket !== runControlSocket) return;
    runPanelState = {
      ...runPanelState,
      inputDevices: result.inputDevices ?? [],
      outputDevices: result.outputDevices ?? [],
      midiInputDevices: result.midiInputDevices
        ? normalizeMidiInputDevices(result.midiInputDevices)
        : runPanelState.midiInputDevices,
      error: undefined,
    };
    postRunPanelState();
  } catch (error) {
    if (socket !== runControlSocket) return;
    const message = error instanceof Error ? error.message : String(error);
    runPanelState = {
      ...runPanelState,
      error: message,
    };
    postRunPanelState();
  }
}

function triggerRunMidiNote(
  key: unknown,
  velocity: unknown,
  pressed: unknown,
): void {
  if (!runPanelState.connected) {
    return;
  }
  const event = runMidiNoteEvent(runPanelState.midi, key, velocity, pressed);
  if (!event) {
    return;
  }
  sendRunControlNotification("triggerEvent", {
    name: event.name,
    values: event.values,
  });
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

function ensureRunPanel(preserveFocus = false): void {
  if (runPanel) {
    postRunPanelState();
    return;
  }

  runPanel = vscode.window.createWebviewPanel(
    "ondaRun",
    "Onda Run",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  runPanelReady = false;
  const panel = runPanel;
  runPanel.onDidChangeViewState(() => {
    if (runPanel !== panel) return;
    syncScopeCapture();
    pollScopeData();
  });
  runPanel.onDidDispose(() => {
    if (runPanel !== panel) return;
    stopScopePolling();
    runPanelReady = false;
    lastPostedRunState = undefined;
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
      key?: number;
      velocity?: number;
      pressed?: boolean;
      milliseconds?: number;
      columns?: number;
      visible?: boolean;
      meter?: boolean;
      sampleRateHz?: number;
      blockSamples?: number;
    };
    switch (payload.type) {
      case "scopeConfig":
        if (Number.isInteger(payload.columns) && payload.columns! >= 1 && payload.columns! <= 512 && scopeColumns !== payload.columns) {
          scopeColumns = payload.columns!;
          ++scopePollingEpoch;
          scopePollingInFlight = false;
        }
        scopeViewVisible = payload.visible === true;
        scopeMeterVisible = payload.meter === true;
        syncScopeCapture();
        pollScopeData();
        break;
      case "uiReady":
        runPanelReady = true;
        lastPostedRunState = undefined;
        postRunPanelState();
        syncScopeCapture();
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
        await runFile(payload.path ?? runPanelState.path, { fastMath: runPanelState.fastMath });
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
      case "clearLog":
        runPanelState = {
          ...runPanelState,
          ...clearRunLogState(runPanelState),
        };
        postRunPanelState();
        break;
      case "refreshDevices":
        await refreshRunDevices();
        break;
      case "setParam":
        if (typeof payload.name === "string") {
          applyRunParamChange(payload.name, payload.value ?? null);
        }
        break;
      case "setParamSmoothing":
        await updateRunParamSmoothing(payload.milliseconds);
        break;
      case "setRunSettings":
        await updateRunSettings(payload.sampleRateHz, payload.blockSamples);
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
      case "setMidiInputDevice":
        await updateRunDeviceSelection("midi", payload.name);
        break;
      case "midiNote":
        triggerRunMidiNote(payload.key, payload.velocity, payload.pressed);
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
  runPanel.webview.html = renderGpuRunHtml(runPanel.webview);
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

function revealRunPanel(preserveFocus = false): void {
  if (!runPanel) {
    return;
  }
  runPanel.reveal(runPanel.viewColumn, preserveFocus);
}

let lastPostedRunState: Record<string, unknown> | undefined;
function postRunPanelState(options: { resetEventArguments?: boolean } = {}): void {
  if (!runPanel) {
    return;
  }
  const state: Record<string, unknown> = {
    ...runPanelState,
    processingRequested: runProcessingRequested,
    schemaReady: runSchemaReady,
    // Undefined fields are omitted when VS Code serializes webview messages.
    // Send an explicit clear so the view does not retain a previous error.
    error: runPanelState.error ?? null,
    ondaVersion: client?.initializeResult?.serverInfo?.version ?? undefined,
    ...(options.resetEventArguments ? { resetEventArguments: true } : {}),
    supportsSourceSelection: false,
    supportsProjectExport: Boolean(
      runPanelState.path && isOndaSourcePath(runPanelState.path),
    ),
    canExportProject: Boolean(
      runPanelState.path && isOndaSourcePath(runPanelState.path),
    ),
    supportsTransport: true,
    supportsDeviceSelection: true,
    supportsMidiInputSelection: true,
    supportsRunSettings: true,
    canSetSampleRate: true,
    canSetBlockSize: true,
    supportsParamSmoothing: true,
    paramSmoothingDefaultMs: DEFAULT_PARAM_SMOOTHING_MS,
    supportsScope: true,
    themeMode: ondaRunThemeSetting(),
  };
  const patch = !lastPostedRunState || !runPanelReady || state.path !== lastPostedRunState.path
    ? state
    : Object.fromEntries(Object.entries(state).filter(([key, value]) => !Object.is(value, lastPostedRunState![key])));
  // Reset is an instruction, so consecutive requests must each cross the bridge.
  if (options.resetEventArguments) patch.resetEventArguments = true;
  if (runPanelReady) lastPostedRunState = state;
  if (Object.keys(patch).length > 0) {
    void runPanel.webview.postMessage({ type: "state", state: patch });
  }
}

function startScopePolling(): void {
  scopePollingRequested = true;
  syncScopeCapture();
}

function stopScopePolling(): void {
  scopePollingRequested = false;
  syncScopeCapture();
}

function syncScopeCapture(): boolean {
  const socketChanged = scopeCaptureSocket !== runControlSocket;
  scopeCaptureSocket = runControlSocket;
  const active = Boolean(
    scopePollingRequested && runPanelState.running && runPanelState.connected &&
    runPanel && runPanelReady && runPanel.visible !== false,
  );
  const mode = !active ? "off" : scopeViewVisible ? "waveform" : scopeMeterVisible ? "meter" : "off";
  if (socketChanged || mode !== scopeCaptureMode) {
    sendRunControlNotification("setScopeCaptureMode", { value: mode });
    scopeCaptureMode = mode;
    ++scopePollingEpoch;
    scopePollingInFlight = false;
    if (scopePollingTimer !== undefined) clearInterval(scopePollingTimer);
    scopePollingTimer = mode === "off" ? undefined : setInterval(
      pollScopeData, SCOPE_POLL_INTERVAL_MS,
    );
  }
  return mode !== "off";
}

function pollScopeData(): void {
  if (!syncScopeCapture() || scopePollingInFlight) return;
  scopePollingInFlight = true;
  const socket = runControlSocket;
  const epoch = scopePollingEpoch;
  sendRunControlRequest<{ channels?: number; peaks?: number[]; samples?: number[]; packet?: string }>("getScopeData", {
    maxFrames: SCOPE_MAX_FRAMES,
    columns: scopeColumns,
  })
    .then((result) => {
      if (socket !== runControlSocket || epoch !== scopePollingEpoch) return;
      scopePollingInFlight = false;
      if (syncScopeCapture()) {
        void runPanel!.webview.postMessage({
          type: "scopeData",
          channels: result.channels,
          peaks: result.peaks,
          samples: scopeViewVisible ? result.samples : undefined,
          packet: scopeViewVisible ? result.packet : undefined,
        });
      }
    })
    .catch(() => {
      if (socket !== runControlSocket || epoch !== scopePollingEpoch) return;
      scopePollingInFlight = false;
    });
}

function renderGpuRunHtml(webview: vscode.Webview): string {
  const root = extensionContext?.extensionPath ?? __dirname;
  const htmlPath = path.join(root, "out", "gpu", "index.html");
  if (!fs.existsSync(htmlPath)) {
    return '<html><body style="font:14px system-ui;color:#dce8f4;background:#07101a;padding:24px">Onda UI could not be loaded. Reinstall the extension.</body></html>';
  }
  const hostUri = webview.asWebviewUri(vscode.Uri.file(path.join(root, "out", "gpu", "host.js")));
  const csp = `default-src 'none'; script-src ${webview.cspSource} 'wasm-unsafe-eval'; connect-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src 'unsafe-inline'`;
  const baseUri = webview.asWebviewUri(vscode.Uri.file(path.join(root, "out", "gpu"))).toString() + "/";
  return fs.readFileSync(htmlPath, "utf8")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${baseUri}">`)
    .replace("./host.js", hostUri.toString());
}

function ondaRunThemeSetting(): "auto" | "dark" | "light" {
  const config = vscode.workspace.getConfiguration("onda");
  const value = config.get<string>("run.theme", "auto");
  if (value === "dark" || value === "light") {
    return value;
  }
  return "auto";
}

function ondaRunAudioSettings(): { sampleRateHz: number; blockFrames: number; args: string[] } {
  const config = vscode.workspace.getConfiguration("onda");
  const sampleRate = runAudioOverrides.sampleRateHz ?? explicitPositiveIntegerSetting(config, "run.sampleRate");
  const blockSize = runAudioOverrides.blockFrames ?? explicitPositiveIntegerSetting(config, "run.blockSize");
  const args: string[] = [];
  if (sampleRate !== undefined) {
    args.push("--sample-rate", sampleRate.toString());
  }
  if (blockSize !== undefined) {
    args.push("--block-size", blockSize.toString());
  }
  return {
    sampleRateHz: sampleRate ?? DEFAULT_RUN_SAMPLE_RATE_HZ,
    blockFrames: blockSize ?? DEFAULT_RUN_BLOCK_FRAMES,
    args,
  };
}

function explicitPositiveIntegerSetting(
  config: vscode.WorkspaceConfiguration,
  name: string,
): number | undefined {
  const inspected = config.inspect<number>(name);
  const hasOverride = inspected && [
    inspected.globalValue,
    inspected.workspaceValue,
    inspected.workspaceFolderValue,
    inspected.globalLanguageValue,
    inspected.workspaceLanguageValue,
    inspected.workspaceFolderLanguageValue,
  ].some((value) => value !== undefined);
  const value = config.get<number>(name);
  return hasOverride && typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

async function startClient(): Promise<void> {
  const { command, extraArgs, source } = ondaExecutableConfig();
  const args = [...extraArgs, "lsp"];
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
      fileEvents: languageFileWatchers,
    },
    outputChannel: serverOutput,
    traceOutputChannel: serverOutput,
  };

  client = new LanguageClient("onda-lsp", "Onda Language Server", serverOptions, clientOptions);
  try {
    await client.start();
    postRunPanelState();
  } catch (error) {
    client = undefined;
    const description = describeOndaExecutableError(command, error, source);
    serverOutput?.appendLine(`Failed to start: ${description.message}`);
    // A notification can stay open indefinitely; it must not hold the restart queue.
    void showOndaCommandError("Onda language server could not start", command, error, source)
      .catch((notificationError) => serverOutput?.appendLine(`Failed to show compiler error: ${notificationError}`));
  }
}
