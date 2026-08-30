export interface RunDelegateParamMetadata {
  name: string;
  type: string;
}

export interface RunDelegateMetadata {
  index: number;
  name: string;
  params: RunDelegateParamMetadata[];
}

export interface RunLogState {
  logText: string;
  logEntries: unknown[];
  logRevealed: boolean;
  printOverflowCount: number;
  printTransportDropCount: number;
  delegateOverflowCount: number;
  delegateTransportDropCount: number;
}

const MAX_VISIBLE_LOG_ENTRIES = 4096;

export function initialRunLogState(): RunLogState {
  return {
    logText: "",
    logEntries: [],
    logRevealed: false,
    printOverflowCount: 0,
    printTransportDropCount: 0,
    delegateOverflowCount: 0,
    delegateTransportDropCount: 0,
  };
}

export function clearRunLogState(state: RunLogState): RunLogState {
  return {
    ...initialRunLogState(),
    logRevealed: state.logRevealed,
  };
}

export function applyRunOutputNotification(
  state: RunLogState,
  payload: unknown,
  delegates: RunDelegateMetadata[],
): RunLogState | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (payload.event === "print") {
    return applyPrintNotification(state, payload);
  }
  if (payload.event === "delegates") {
    return applyDelegateNotification(state, payload, delegates);
  }
  return undefined;
}

function applyPrintNotification(
  state: RunLogState,
  payload: Record<string, unknown>,
): RunLogState {
  const text = typeof payload.text === "string" ? payload.text : "";
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const overflowCount = lossCount(payload.overflowCount);
  const transportDropCount = lossCount(payload.transportDropCount);
  const next = cloneLogState(state);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  for (let index = 0; index < lines.length; index += 1) {
    next.logText += `${lines[index]}\n`;
    next.logEntries.push(entries[index] ?? null);
  }
  next.logRevealed ||=
    lines.length > 0 || entries.length > 0 || overflowCount > 0 || transportDropCount > 0;
  next.printOverflowCount = saturatingAdd(next.printOverflowCount, overflowCount);
  next.printTransportDropCount = saturatingAdd(
    next.printTransportDropCount,
    transportDropCount,
  );
  trimLogHistory(next);
  return next;
}

function applyDelegateNotification(
  state: RunLogState,
  payload: Record<string, unknown>,
  delegates: RunDelegateMetadata[],
): RunLogState {
  const occurrences = Array.isArray(payload.occurrences)
    ? payload.occurrences.filter(isRecord)
    : [];
  const overflowCount = lossCount(payload.overflowCount);
  const transportDropCount = lossCount(payload.transportDropCount);
  const next = cloneLogState(state);
  for (const occurrence of occurrences) {
    next.logText += `${formatDelegateLogLine(occurrence, delegates)}\n`;
    next.logEntries.push({ kind: "delegate", delegate: occurrence });
  }
  next.logRevealed ||=
    occurrences.length > 0 || overflowCount > 0 || transportDropCount > 0;
  next.delegateOverflowCount = saturatingAdd(next.delegateOverflowCount, overflowCount);
  next.delegateTransportDropCount = saturatingAdd(
    next.delegateTransportDropCount,
    transportDropCount,
  );
  trimLogHistory(next);
  return next;
}

function cloneLogState(state: RunLogState): RunLogState {
  return {
    ...state,
    logEntries: [...state.logEntries],
  };
}

function trimLogHistory(state: RunLogState): void {
  const excess = Math.max(0, state.logEntries.length - MAX_VISIBLE_LOG_ENTRIES);
  if (excess === 0) {
    return;
  }
  state.logEntries.splice(0, excess);
  const lines = state.logText.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const retained = lines.slice(excess);
  state.logText = retained.length > 0 ? `${retained.join("\n")}\n` : "";
}

function formatDelegateLogLine(
  occurrence: Record<string, unknown>,
  delegates: RunDelegateMetadata[],
): string {
  const name = typeof occurrence.name === "string" ? occurrence.name : "delegate";
  const values = isRecord(occurrence.values) ? occurrence.values : undefined;
  if (!values) {
    return `delegate ${name}`;
  }
  const index = typeof occurrence.index === "number" ? occurrence.index : undefined;
  const metadata = delegates.find((delegate) => delegate.index === index);
  const fields = metadata
    ? metadata.params.flatMap((param) => (
        Object.hasOwn(values, param.name)
          ? [`${param.name}=${formatLogValue(values[param.name], param.type)}`]
          : []
      ))
    : Object.entries(values).map(([field, value]) => `${field}=${formatLogValue(value)}`);
  return fields.length > 0
    ? `delegate ${name}: ${fields.join(" ")}`
    : `delegate ${name}`;
}

function formatLogValue(value: unknown, type?: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatLogValue(item, type)).join(", ")}]`;
  }
  if (
    typeof value === "number"
    && (type?.split("[")[0] === "i32" || type?.split("[")[0] === "i64")
    && Number.isInteger(value)
  ) {
    return value.toFixed(0);
  }
  return JSON.stringify(value) ?? String(value);
}

function lossCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
