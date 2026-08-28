import type {
  CodexAppServerProcessLike,
  CodexAppServerProcessOptions,
} from "./types";
import { providerRequestFailed } from "../shared/localizedErrors";

type RawSubprocess = {
  stdin?: { write?: (line: string) => void | Promise<void> };
  stdout?: { readString?: () => string | Promise<string | Uint8Array> };
  kill?: () => void | Promise<void>;
  wait?: () => unknown;
};

type SubprocessModule = {
  call(options: {
    command: string;
    arguments: string[];
    stderr: "pipe";
  }): unknown | Promise<unknown>;
};

function codexError(fallback: string): string {
  try {
    return providerRequestFailed("Codex App Server");
  } catch {
    return fallback;
  }
}

/**
 * Adapts Zotero's Subprocess stream to the small line-oriented surface used by
 * the JSON-RPC client. No Node.js process APIs are required in this layer.
 */
export class CodexAppServerProcess implements CodexAppServerProcessLike {
  private readonly raw: RawSubprocess;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();
  private lineBuffer = "";
  private closed = false;
  private exitNotified = false;
  private readLoopPromise: Promise<void> | undefined;

  constructor(rawProcess: unknown) {
    this.raw = rawProcess as RawSubprocess;
    this.startReadLoop();
  }

  /** Wrap an already-created Zotero subprocess, chiefly useful to embedders. */
  static fromSubprocess(rawProcess: unknown): CodexAppServerProcess {
    return new CodexAppServerProcess(rawProcess);
  }

  /** Wrap a process double without invoking Zotero APIs. */
  static forTest(rawProcess: unknown): CodexAppServerProcess {
    return new CodexAppServerProcess(rawProcess);
  }

  static async loadSubprocessModule(): Promise<SubprocessModule> {
    const chromeUtils = (globalThis as any).ChromeUtils;
    let moduleValue: any;

    if (typeof chromeUtils?.importESModule === "function") {
      try {
        moduleValue = chromeUtils.importESModule(
          "resource://gre/modules/Subprocess.sys.mjs",
        );
      } catch {
        moduleValue = undefined;
      }
    }

    if (!moduleValue?.Subprocess?.call && !moduleValue?.call) {
      if (typeof chromeUtils?.import === "function") {
        try {
          moduleValue = chromeUtils.import(
            "resource://gre/modules/Subprocess.jsm",
          );
        } catch {
          moduleValue = undefined;
        }
      }
    }

    const subprocess =
      moduleValue?.Subprocess || moduleValue?.default || moduleValue;
    if (typeof subprocess?.call !== "function") {
      throw new Error(codexError("codex-subprocess-unavailable"));
    }
    return subprocess as SubprocessModule;
  }

  static async spawn(
    options: CodexAppServerProcessOptions = {},
  ): Promise<CodexAppServerProcess> {
    const subprocess = await this.loadSubprocessModule();
    const command =
      options.codexBinaryPath?.trim() || options.binaryPath?.trim() || "codex";
    const raw = await subprocess.call({
      command,
      // stdio JSONL is the app-server default; keeping the invocation to the
      // stable subcommand also works with older Codex CLI releases.
      arguments: ["app-server"],
      stderr: "pipe",
    });
    if (!raw) {
      throw new Error(codexError("codex-subprocess-not-started"));
    }
    return new CodexAppServerProcess(raw);
  }

  write(line: string): void | Promise<void> {
    if (this.closed) {
      throw new Error(codexError("codex-process-closed"));
    }
    if (typeof this.raw.stdin?.write !== "function") {
      throw new Error(codexError("codex-stdin-unavailable"));
    }
    return this.raw.stdin.write(line);
  }

  onLine(listener: (line: string) => void): () => void {
    if (this.closed) return () => undefined;
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (code?: number) => void): () => void {
    if (this.exitNotified) {
      listener();
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  kill(): void | Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const result = this.raw.kill?.();
    this.notifyExit();
    return result;
  }

  /** Wait for the stream reader to stop, without making callers depend on it. */
  async wait(): Promise<void> {
    await this.readLoopPromise;
  }

  private startReadLoop(): void {
    if (typeof this.raw.stdout?.readString !== "function") return;
    this.readLoopPromise = this.readLoop();
    void this.readLoopPromise.catch(() => {
      this.closed = true;
      this.notifyExit();
    });
  }

  private async readLoop(): Promise<void> {
    const readString = this.raw.stdout?.readString;
    if (typeof readString !== "function") return;

    while (!this.closed) {
      const rawChunk = await readString.call(this.raw.stdout);
      const chunk = this.decodeChunk(rawChunk);
      if (!chunk) break;
      this.lineBuffer += chunk;
      const lines = this.lineBuffer.split(/\r?\n/);
      this.lineBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        for (const listener of this.lineListeners) {
          try {
            listener(`${line}\n`);
          } catch {
            // A consumer callback must not terminate the process reader.
          }
        }
      }
    }

    if (this.lineBuffer.trim()) {
      for (const listener of this.lineListeners) {
        try {
          listener(this.lineBuffer);
        } catch {
          // Ignore consumer failures while flushing the last line.
        }
      }
      this.lineBuffer = "";
    }
    this.closed = true;
    this.notifyExit();
  }

  private decodeChunk(chunk: string | Uint8Array): string {
    if (typeof chunk === "string") return chunk;
    try {
      return new TextDecoder().decode(chunk);
    } catch {
      return "";
    }
  }

  private notifyExit(code?: number): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    for (const listener of this.exitListeners) {
      try {
        listener(code);
      } catch {
        // Exit listeners are diagnostics/cleanup hooks and must be isolated.
      }
    }
    this.exitListeners.clear();
  }
}

export default CodexAppServerProcess;
