import { mergeRunDependencies, normalizeRunPath, parseRunSourceGraph } from "./runDependencies";
import { RunFileWatcher } from "./runFileWatcher";

interface Entry {
  files: Set<string>;
  pending?: AbortController;
}

/** Owns disk dependency discovery and watching for the current language server. */
export class LanguageDependencies {
  private readonly entries = new Map<string, Entry>();
  private readonly watcher: RunFileWatcher;
  private discovery: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly discover: (file: string, signal: AbortSignal) => Promise<unknown>,
    private readonly changed: (files: string[]) => void,
    private readonly reportError: (file: string, error: unknown) => void,
  ) {
    this.watcher = new RunFileWatcher((files) => {
      changed(files);
      for (const [file, entry] of this.entries) {
        if (files.some(changed => entry.files.has(changed))) void this.open(file);
      }
    }, undefined, reportError);
  }

  open(file: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    file = normalizeRunPath(file);
    let entry = this.entries.get(file);
    if (!entry) {
      entry = { files: new Set([file]) };
      this.entries.set(file, entry);
      this.updateWatches();
    }
    entry.pending?.abort();
    const pending = new AbortController();
    entry.pending = pending;
    const currentEntry = entry;
    const current = () => this.entries.get(file) === currentEntry && !pending.signal.aborted;
    // Serialize frontend work; opening many editors must not start one compiler per editor at once.
    const refreshed = this.discovery.then(async () => {
      if (!current()) return;
      try {
        const graph = parseRunSourceGraph(await this.discover(file, pending.signal));
        if (!current()) return;
        if (!graph) throw new Error("Invalid source graph from Onda.");
        currentEntry.files = mergeRunDependencies(file, currentEntry.files, graph);
        this.updateWatches();
        if (graph.contentHashes) await this.watcher.validate(graph.contentHashes);
        // Discovery may observe a repair after the LSP's last analysis, before
        // its dependency was watched. Revalidate once against the installed graph.
        if (current()) this.changed([file]);
      } catch (error) {
        if (current()) this.reportError(file, error);
      }
    });
    this.discovery = refreshed;
    return refreshed;
  }

  close(file: string): void {
    file = normalizeRunPath(file);
    this.entries.get(file)?.pending?.abort();
    this.entries.delete(file);
    this.updateWatches();
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.pending?.abort();
    this.entries.clear();
    this.watcher.dispose();
  }

  private updateWatches(): void {
    this.watcher.update([...this.entries.values()].flatMap(entry => [...entry.files]));
  }
}
