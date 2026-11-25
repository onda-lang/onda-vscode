import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// onda fmt rewrites a file in place. Give it the editor snapshot so formatting
// also works for dirty and untitled documents without touching the user's file.
export async function formatSource(
  command: string, extraArgs: string[], source: string, signal: AbortSignal,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "onda-fmt-"));
  try {
    const file = join(directory, "source.onda");
    await writeFile(file, source, "utf8");
    await run(command, [...extraArgs, "fmt", file], { signal, windowsHide: true });
    return await readFile(file, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
