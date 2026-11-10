import { mergeRunDependencies, normalizeRunPath, parseRunSourceGraph } from "./runDependencies";
import { RunFileWatcher } from "./runFileWatcher";

interface Entry {
  files: Set<string>;
  pending?: AbortController;
}

/** Watches source graphs resolved from the current language-server documents. */
export class LanguageDependencies {
  private readonly entries = new Map<string, Entry>();
  private readonly watcher: RunFileWatcher;
  private discovery: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly discover: (file: string, signal: AbortSignal) => Promise<unknown>,
    private readonly changed: (files: string[]) => void,
    private readonly reportError: (file: string, error: unknown) => void,
  ) {
    this.watcher = new RunFileWatcher((files) => {
      changed(files);
      for (const file of files) this.change(file);
    }, undefined, reportError);
  }

  async open(file: string): Promise<void> {
    if (this.disposed) return;
    file = normalizeRunPath(file);
    if (!this.entries.has(file)) {
      this.entries.set(file, { files: new Set([file]) });
      this.updateWatches();
    }
    await Promise.all(this.affected(file).map(([path, entry]) => this.refresh(path, entry)));
  }

  change(file: string): void {
    if (this.disposed) return;
    for (const [path, entry] of this.affected(normalizeRunPath(file))) {
      entry.pending?.abort();
      this.queued.add(path);
    }
    if (this.queued.size === 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const files = [...this.queued];
      this.queued.clear();
      for (const file of files) {
        const entry = this.entries.get(file);
        if (entry) void this.refresh(file, entry);
      }
    }, 100);
  }

  private refresh(file: string, entry: Entry): Promise<void> {
    this.queued.delete(file);
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
    this.queued.delete(file);
    this.updateWatches();
    this.change(file);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.queued.clear();
    for (const entry of this.entries.values()) entry.pending?.abort();
    this.entries.clear();
    this.watcher.dispose();
  }

  private updateWatches(): void {
    this.watcher.update([...this.entries.values()].flatMap(entry => [...entry.files]));
  }

  private affected(file: string): [string, Entry][] {
    return [...this.entries].filter(([, entry]) => entry.files.has(file));
  }
}
