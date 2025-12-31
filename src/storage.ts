import { readdir, readFile, stat, open } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import type {
  HistoryEntry,
  Session,
  ConversationMessage,
  StreamResult,
} from "@claude-run/shared";

export class ClaudeStorage {
  private readonly claudeDir: string;
  private readonly projectsDir: string;
  private readonly fileIndex: Map<string, string> = new Map();
  private historyCache: HistoryEntry[] | null = null;
  private readonly pendingRequests: Map<string, Promise<unknown>> = new Map();

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir ?? join(homedir(), ".claude");
    this.projectsDir = join(this.claudeDir, "projects");
  }

  async init(): Promise<void> {
    await Promise.all([this.buildFileIndex(), this.loadHistoryCache()]);
  }

  private async buildFileIndex(): Promise<void> {
    try {
      const projectDirs = await readdir(this.projectsDir, {
        withFileTypes: true,
      });

      const directories = projectDirs.filter((d) => d.isDirectory());

      await Promise.all(
        directories.map(async (dir) => {
          try {
            const projectPath = join(this.projectsDir, dir.name);
            const files = await readdir(projectPath);
            for (const file of files) {
              if (file.endsWith(".jsonl")) {
                const sessionId = basename(file, ".jsonl");
                this.fileIndex.set(sessionId, join(projectPath, file));
              }
            }
          } catch {
            // Ignore errors for individual directories
          }
        })
      );
    } catch {
      // Projects directory may not exist yet
    }
  }

  private async loadHistoryCache(): Promise<HistoryEntry[]> {
    try {
      const historyPath = join(this.claudeDir, "history.jsonl");
      const content = await readFile(historyPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const entries: HistoryEntry[] = [];

      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }

      this.historyCache = entries;
      return entries;
    } catch {
      this.historyCache = [];
      return [];
    }
  }

  invalidateHistoryCache(): void {
    this.historyCache = null;
  }

  addToFileIndex(sessionId: string, filePath: string): void {
    this.fileIndex.set(sessionId, filePath);
  }

  private async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pendingRequests.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.pendingRequests.delete(key);
    });

    this.pendingRequests.set(key, promise);
    return promise;
  }

  private encodeProjectPath(path: string): string {
    return path.replace(/[/.]/g, "-");
  }

  private getProjectName(projectPath: string): string {
    const parts = projectPath.split("/").filter(Boolean);
    return parts[parts.length - 1] || projectPath;
  }

  async getSessions(): Promise<Session[]> {
    return this.dedupe("getSessions", async () => {
      const entries = this.historyCache ?? (await this.loadHistoryCache());
      const sessions: Session[] = [];
      const seenIds = new Set<string>();

      for (const entry of entries) {
        let sessionId = entry.sessionId;
        if (!sessionId) {
          const encodedProject = this.encodeProjectPath(entry.project);
          sessionId = await this.findSessionByTimestamp(
            encodedProject,
            entry.timestamp
          );
        }

        if (!sessionId || seenIds.has(sessionId)) {
          continue;
        }

        seenIds.add(sessionId);
        sessions.push({
          id: sessionId,
          display: entry.display,
          timestamp: entry.timestamp,
          project: entry.project,
          projectName: this.getProjectName(entry.project),
        });
      }

      return sessions.sort((a, b) => b.timestamp - a.timestamp);
    });
  }

  async getProjects(): Promise<string[]> {
    const entries = this.historyCache ?? (await this.loadHistoryCache());
    const projects = new Set<string>();

    for (const entry of entries) {
      if (entry.project) {
        projects.add(entry.project);
      }
    }

    return [...projects].sort();
  }

  private async findSessionByTimestamp(
    encodedProject: string,
    timestamp: number
  ): Promise<string | null> {
    try {
      const projectPath = join(this.projectsDir, encodedProject);
      const files = await readdir(projectPath);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      const fileStats = await Promise.all(
        jsonlFiles.map(async (file) => {
          const filePath = join(projectPath, file);
          const fileStat = await stat(filePath);
          return { file, mtime: fileStat.mtimeMs };
        })
      );

      let closestFile: string | null = null;
      let closestTimeDiff = Infinity;

      for (const { file, mtime } of fileStats) {
        const timeDiff = Math.abs(mtime - timestamp);
        if (timeDiff < closestTimeDiff) {
          closestTimeDiff = timeDiff;
          closestFile = file;
        }
      }

      if (closestFile) {
        return basename(closestFile, ".jsonl");
      }
    } catch {
      // Project directory doesn't exist
    }

    return null;
  }

  async findSessionFile(sessionId: string): Promise<string | null> {
    if (this.fileIndex.has(sessionId)) {
      return this.fileIndex.get(sessionId)!;
    }

    const targetFile = `${sessionId}.jsonl`;

    try {
      const projectDirs = await readdir(this.projectsDir, {
        withFileTypes: true,
      });

      const directories = projectDirs.filter((d) => d.isDirectory());

      const results = await Promise.all(
        directories.map(async (dir) => {
          try {
            const projectPath = join(this.projectsDir, dir.name);
            const files = await readdir(projectPath);
            if (files.includes(targetFile)) {
              return join(projectPath, targetFile);
            }
          } catch {
            // Ignore errors for individual directories
          }
          return null;
        })
      );

      const filePath = results.find((r) => r !== null);
      if (filePath) {
        this.fileIndex.set(sessionId, filePath);
        return filePath;
      }
    } catch (err) {
      console.error("Error finding session file:", err);
    }

    return null;
  }

  async getConversation(sessionId: string): Promise<ConversationMessage[]> {
    return this.dedupe(`getConversation:${sessionId}`, async () => {
      const filePath = await this.findSessionFile(sessionId);

      if (!filePath) {
        return [];
      }

      const messages: ConversationMessage[] = [];

      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const msg: ConversationMessage = JSON.parse(line);
            if (msg.type === "user" || msg.type === "assistant") {
              messages.push(msg);
            } else if (msg.type === "summary") {
              messages.unshift(msg);
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch (err) {
        console.error("Error reading conversation:", err);
      }

      return messages;
    });
  }

  async getConversationStream(
    sessionId: string,
    fromOffset: number = 0
  ): Promise<StreamResult> {
    const filePath = await this.findSessionFile(sessionId);

    if (!filePath) {
      return { messages: [], nextOffset: 0 };
    }

    const messages: ConversationMessage[] = [];

    let fileHandle;
    try {
      const fileStat = await stat(filePath);
      const fileSize = fileStat.size;

      if (fromOffset >= fileSize) {
        return { messages: [], nextOffset: fromOffset };
      }

      fileHandle = await open(filePath, "r");
      const stream = fileHandle.createReadStream({
        start: fromOffset,
        encoding: "utf-8",
      });

      const rl = createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      let bytesConsumed = 0;
      let lineCount = 0;

      for await (const line of rl) {
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
        lineCount++;

        if (line.trim()) {
          try {
            const msg: ConversationMessage = JSON.parse(line);
            if (msg.type === "user" || msg.type === "assistant") {
              messages.push(msg);
            }
            bytesConsumed += lineBytes;
          } catch {
            break;
          }
        } else {
          bytesConsumed += lineBytes;
        }
      }

      const actualOffset = fromOffset + bytesConsumed;
      const nextOffset = actualOffset > fileSize ? fileSize : actualOffset;

      return {
        messages,
        nextOffset,
      };
    } catch (err) {
      console.error("Error reading conversation stream:", err);
      return { messages: [], nextOffset: fromOffset };
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }

  getClaudeDir(): string {
    return this.claudeDir;
  }

  getProjectsDir(): string {
    return this.projectsDir;
  }
}
