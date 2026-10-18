import * as path from "path";

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
  return { files, complete, contentHashes };
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
    path.resolve(input),
    ...(complete ? [] : previous),
    ...files.map((file: string) => path.resolve(file)),
  ]);
}
