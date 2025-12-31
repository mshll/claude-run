import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import { basename, dirname, join } from "path";

export interface WatcherEvents {
  historyChange: () => void;
  sessionChange: (sessionId: string, filePath: string) => void;
  projectChange: (projectId: string) => void;
}

export class ClaudeWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private readonly claudeDir: string;
  private readonly debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly debounceMs: number = 20;

  constructor(claudeDir: string) {
    super();
    this.claudeDir = claudeDir;
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    const historyPath = join(this.claudeDir, "history.jsonl");
    const projectsDir = join(this.claudeDir, "projects");

    const usePolling = process.env.CLAUDE_RUN_USE_POLLING === "1";

    this.watcher = watch([historyPath, projectsDir], {
      persistent: true,
      ignoreInitial: true,
      usePolling,
      ...(usePolling && { interval: 100 }),
      depth: 2,
    });

    this.watcher.on("change", (path) => this.handleChange(path));
    this.watcher.on("add", (path) => this.handleChange(path));
    this.watcher.on("error", (error) => {
      console.error("Watcher error:", error);
    });
  }

  private handleChange(path: string): void {
    const existing = this.debounceTimers.get(path);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      this.emitChange(path);
    }, this.debounceMs);

    this.debounceTimers.set(path, timer);
  }

  private emitChange(filePath: string): void {
    if (filePath.endsWith("history.jsonl")) {
      this.emit("historyChange");
    } else if (filePath.endsWith(".jsonl")) {
      const sessionId = basename(filePath, ".jsonl");
      const projectId = basename(dirname(filePath));
      this.emit("sessionChange", sessionId, filePath);
      this.emit("projectChange", projectId);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
