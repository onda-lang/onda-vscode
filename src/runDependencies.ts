import * as path from "path";

/** Translate native compiler paths into the host's filesystem spelling. */
export function normalizeRunPath(file: string): string {
  if (process.platform === "win32") {
    if (/^\\\\\?\\[a-z]:\\/i.test(file)) file = file.slice(4);
    else if (/^\\\\\?\\UNC\\/i.test(file)) file = `\\\\${file.slice(8)}`;
    // Drive letters are case-insensitive, including in case-sensitive directories.
    file = file.replace(/^[a-z]:/i, drive => drive.toUpperCase());
  }
  return path.resolve(file);
}

export interface RunSourceGraph {
  files: string[];
  complete: boolean;
  contentHashes?: Record<string, string | null>;
}

export function parseRunSourceGraph(graph: unknown): RunSourceGraph | undefined {
  if (!graph || typeof graph !== "object") return undefined;
  const { files, complete, contentHashes } = graph as Partial<RunSourceGraph>;
  if (typeof complete !== "boolean" || !Array.isArray(files)
    || !files.every((file) => typeof file === "string" && path.isAbsolute(file))) {
    return undefined;
  }
  if (contentHashes !== undefined && (!contentHashes || typeof contentHashes !== "object"
    || Array.isArray(contentHashes) || !Object.entries(contentHashes).every(([file, hash]) =>
      files.includes(file) && (hash === null || (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)))))) {
    return undefined;
  }
  return { files: [...new Set(files.map(normalizeRunPath))], complete,
    contentHashes: contentHashes === undefined ? undefined
      : Object.fromEntries(Object.entries(contentHashes).map(([file, hash]) => [normalizeRunPath(file), hash])) };
}

/** Replace a complete compiler graph, or retain previous files during recovery. */
export function mergeRunDependencies(
  input: string,
  previous: ReadonlySet<string>,
  graph: unknown,
): Set<string> {
  const parsed = parseRunSourceGraph(graph);
  if (!parsed) return new Set(previous);
  const { files, complete } = parsed;
  return new Set([
    normalizeRunPath(input),
    ...(complete ? [] : previous),
    ...files.map(normalizeRunPath),
  ]);
}
