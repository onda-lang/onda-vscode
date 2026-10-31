import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { normalizeRunPath } from "./runDependencies";

interface WatchedFile {
  revision: string | undefined;
  contentHash?: string | null;
  validation?: AbortController;
}

interface DirectoryPlan {
  identity: string;
  children: Map<string, Set<string>>;
}

interface WatchedDirectory extends DirectoryPlan {
  watcher: fs.FSWatcher;
}

function fileRevision(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink()) return undefined;
    for (let directory = path.dirname(file);; directory = path.dirname(directory)) {
      if (fs.lstatSync(directory).isSymbolicLink()) return undefined;
      if (directory === path.dirname(directory)) break;
    }
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch {
    return undefined;
  }
}

async function fileContentHash(file: string, signal: AbortSignal): Promise<string | null> {
  try {
    // Match native loading: symlinks, including ancestor components, are rejected.
    for (let ancestor = file;; ancestor = path.dirname(ancestor)) {
      signal.throwIfAborted();
      if ((await fs.promises.lstat(ancestor)).isSymbolicLink()) return null;
      if (ancestor === path.dirname(ancestor)) break;
    }
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function watchPlan(files: Iterable<string>): Map<string, DirectoryPlan> {
  const plan = new Map<string, DirectoryPlan>();
  for (const file of files) {
    const ancestors: { directory: string; child: string }[] = [];
    for (let child = file;;) {
      const directory = path.dirname(child);
      ancestors.push({ directory, child: path.basename(child) });
      if (directory === path.dirname(directory)) break;
      child = directory;
    }
    // Watch each existing ancestor so missing paths can recover and replacing
    // an entire directory cannot leave a watch attached to its former inode.
    for (const { directory, child } of ancestors.reverse()) {
      let watched = plan.get(directory);
      if (!watched) {
        try {
          const stat = fs.lstatSync(directory, { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink()) break;
          watched = { identity: `${stat.dev}:${stat.ino}`, children: new Map() };
          plan.set(directory, watched);
        } catch {
          break;
        }
      }
      const name = process.platform === "win32" ? child.toLowerCase() : child;
      const targets = watched.children.get(name) ?? new Set<string>();
      targets.add(file);
      watched.children.set(name, targets);
    }
  }
  return plan;
}

/** Watches exact graph paths, including missing files and files outside the workspace. */
export class RunFileWatcher {
  private readonly files = new Map<string, WatchedFile>();
  private readonly directories = new Map<string, WatchedDirectory>();
  private readonly failedDirectories = new Map<string, string>();
  private readonly checks = new Set<string>();
  private fallbackFiles = new Set<string>();
  private fallbackTimer: NodeJS.Timeout | undefined;
  private refresh: NodeJS.Immediate | undefined;
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly validationRetries = new Map<string, string | null>();
  private validationRetryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly shouldDefer = () => false,
    private readonly onValidationError: (file: string, error: unknown) => void = () => {},
  ) {}

  update(paths: Iterable<string>): void {
    const next = new Set(Array.from(paths, normalizeRunPath));
    for (const [file, watched] of this.files) {
      if (next.has(file)) continue;
      watched.validation?.abort();
      this.files.delete(file);
      this.pending.delete(file);
      this.checks.delete(file);
      this.validationRetries.delete(file);
    }
    for (const file of next) {
      if (this.files.has(file)) continue;
      this.files.set(file, { revision: fileRevision(file) });
    }
    this.reconcileDirectories();
    // Close the registration gap without a recurring timer.
    for (const file of this.files.keys()) this.check(file);
  }

  /** The next compile consumes this disk state, including changes not yet notified. */
  acknowledge(): void {
    this.cancelPending();
    this.cancelValidationRetries();
    for (const [file, watched] of this.files) {
      watched.revision = fileRevision(file);
      watched.validation?.abort();
      watched.validation = undefined;
      // The next compilation supplies a new content baseline.
      watched.contentHash = undefined;
    }
  }

  /** Close the gap between the compiler's reads and filesystem registration. */
  async validate(contentHashes: Record<string, string | null>): Promise<void> {
    const checks = Object.entries(contentHashes).flatMap(([file, expected]) => {
      file = normalizeRunPath(file);
      const watched = this.files.get(file);
      if (!watched) return [];
      watched.validation?.abort();
      const validation = new AbortController();
      watched.validation = validation;
      watched.contentHash = expected;
      return [{ file, expected, watched, validation }];
    });
    // Stream assets one at a time to bound memory and open file descriptors.
    for (const { file, expected, watched, validation } of checks) {
      const current = () => this.files.get(file) === watched && watched.validation === validation;
      if (!current()) continue;
      let actual: string | null;
      try {
        actual = await fileContentHash(file, validation.signal);
      } catch (error) {
        if (current() && !validation.signal.aborted) {
          const report = !this.validationRetries.has(file);
          this.validationRetries.set(file, expected);
          this.scheduleValidationRetry();
          if (report) this.onValidationError(file, error);
        }
        continue;
      }
      if (!current()) continue;
      this.validationRetries.delete(file);
      if (actual !== expected) this.changed(file);
      else this.pending.delete(file);
    }
  }

  isCurrent(file: string): boolean {
    file = normalizeRunPath(file);
    const watched = this.files.get(file);
    return watched?.revision !== undefined && !this.pending.has(file)
      && !this.validationRetries.has(file)
      && watched.revision === fileRevision(file);
  }

  dispose(): void {
    this.cancelPending();
    this.cancelValidationRetries();
    if (this.refresh) clearImmediate(this.refresh);
    this.refresh = undefined;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = undefined;
    for (const watched of this.files.values()) watched.validation?.abort();
    this.files.clear();
    const directories = [...this.directories.values()];
    this.directories.clear();
    for (const { watcher } of directories) watcher.close();
    this.failedDirectories.clear();
    this.fallbackFiles.clear();
    this.checks.clear();
  }

  private reconcileDirectories(): void {
    const plan = watchPlan(this.files.keys());
    for (const [directory, watched] of this.directories) {
      const next = plan.get(directory);
      if (next?.identity === watched.identity) {
        watched.children = next.children;
      } else {
        this.directories.delete(directory);
        watched.watcher.close();
      }
    }
    for (const directory of this.failedDirectories.keys()) {
      if (!plan.has(directory)) this.failedDirectories.delete(directory);
    }
    const fallback = new Set<string>();
    for (const [directory, next] of plan) {
      if (this.directories.has(directory)) continue;
      if (this.failedDirectories.get(directory) !== next.identity) {
        try {
          const watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
            const watched = this.directories.get(directory);
            if (watched?.watcher !== watcher) return;
            const name = filename?.toString();
            const files = name === undefined
              ? [...watched.children.values()].flatMap(files => [...files])
              : watched.children.get(process.platform === "win32" ? name.toLowerCase() : name);
            if (files) this.queueChecks(files);
          });
          const watched = { ...next, watcher };
          this.directories.set(directory, watched);
          this.failedDirectories.delete(directory);
          const failed = () => {
            if (this.directories.get(directory) !== watched) return;
            this.directories.delete(directory);
            this.failedDirectories.set(directory, watched.identity);
            watcher.close();
            this.reconcileDirectories();
            this.queueChecks([...watched.children.values()].flatMap(files => [...files]));
          };
          watcher.on("error", failed);
          watcher.on("close", failed);
          continue;
        } catch {
          this.failedDirectories.set(directory, next.identity);
        }
      }
      for (const files of next.children.values()) for (const file of files) fallback.add(file);
    }
    this.fallbackFiles = fallback;
    if (fallback.size > 0 && !this.fallbackTimer) {
      this.fallbackTimer = setInterval(() => {
        const files = this.fallbackFiles;
        this.failedDirectories.clear();
        this.reconcileDirectories();
        for (const file of files) this.check(file);
      }, 1000);
      this.fallbackTimer.unref();
    } else if (fallback.size === 0 && this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
  }

  private queueChecks(files: Iterable<string>): void {
    for (const file of files) this.checks.add(file);
    if (this.refresh) return;
    this.refresh = setImmediate(() => {
      this.refresh = undefined;
      const files = [...this.checks];
      this.checks.clear();
      this.reconcileDirectories();
      for (const file of files) this.check(file, true);
    });
    this.refresh.unref();
  }

  private check(file: string, checkContents = false): void {
    const watched = this.files.get(file);
    if (!watched) return;
    const revision = fileRevision(file);
    const changed = revision !== watched.revision;
    if (!changed && !checkContents) return;
    watched.revision = revision;
    if (watched.contentHash !== undefined) {
      void this.validate({ [file]: watched.contentHash });
    } else if (changed) {
      this.changed(file);
    }
  }

  private scheduleValidationRetry(): void {
    if (this.validationRetryTimer || this.validationRetries.size === 0) return;
    this.validationRetryTimer = setTimeout(() => {
      this.validationRetryTimer = undefined;
      void this.validate(Object.fromEntries(this.validationRetries));
    }, 1000);
    this.validationRetryTimer.unref();
  }

  private cancelValidationRetries(): void {
    if (this.validationRetryTimer) clearTimeout(this.validationRetryTimer);
    this.validationRetryTimer = undefined;
    this.validationRetries.clear();
  }

  private changed(file: string): void {
    this.pending.add(file);
    if (this.timer) clearTimeout(this.timer);
    this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.pending.size === 0) return;
      if (this.shouldDefer()) {
        this.schedule();
        return;
      }
      this.pending.clear();
      this.onChange();
    }, 100);
    this.timer.unref();
  }

  private cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
