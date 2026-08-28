import type {
  CodexAppServerProcessLike,
  CodexAppServerProcessOptions,
} from "./types";
import { providerRequestFailed } from "../shared/localizedErrors";

type RawSubprocess = {
  stdin?: { write?: (line: string) => void | Promise<void> };
  stdout?: { readString?: () => string | Promise<string | Uint8Array> };
  stderr?: { readString?: () => string | Promise<string | Uint8Array> };
  kill?: () => void | Promise<void>;
  wait?: () => unknown | Promise<unknown>;
};

type SubprocessModule = {
  call(options: {
    command: string;
    arguments: string[];
    stderr: "pipe";
  }): unknown | Promise<unknown>;
  pathSearch?: (
    command: string,
    environment?: unknown,
  ) => string | Promise<string | undefined | null>;
};

const MAX_DIAGNOSTIC_LENGTH = 4000;
const STDERR_DRAIN_WAIT_MS = 100;

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
  private static readonly activeProcesses = new Set<CodexAppServerProcess>();

  private readonly raw: RawSubprocess;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();
  private lineBuffer = "";
  private diagnosticBuffer = "";
  private closed = false;
  private exitNotified = false;
  private exitCode: number | undefined;
  private readLoopPromise: Promise<void> | undefined;
  private stderrLoopPromise: Promise<void> | undefined;
  private waitPromise: Promise<void> | undefined;

  constructor(rawProcess: unknown) {
    this.raw = rawProcess as RawSubprocess;
    CodexAppServerProcess.activeProcesses.add(this);
    this.startWaitLoop();
    this.startReadLoop();
    this.startStderrReadLoop();
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
    const command = await this.resolveExecutablePath(subprocess, options);
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

  /** Stop every task-scoped Codex process during plugin shutdown. */
  static cleanup(): void {
    for (const process of Array.from(this.activeProcesses)) {
      try {
        const result = process.kill();
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Best-effort cleanup; another process must still be stopped.
      }
    }
  }

  static cleanupAll(): void {
    this.cleanup();
  }

  private static async resolveExecutablePath(
    subprocess: SubprocessModule,
    options: CodexAppServerProcessOptions,
  ): Promise<string> {
    const configured =
      options.codexBinaryPath?.trim() || options.binaryPath?.trim() || "codex";
    if (this.isAbsolutePath(configured)) return configured;
    if (typeof subprocess.pathSearch !== "function") {
      throw new Error(codexError("codex-executable-path-search-unavailable"));
    }
    const searched = await subprocess.pathSearch(configured);
    if (!searched || !this.isAbsolutePath(searched)) {
      throw new Error(codexError("codex-executable-not-found"));
    }
    return searched;
  }

  private static isAbsolutePath(value: string): boolean {
    return (
      /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
    );
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
      listener(this.exitCode);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  kill(): void | Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let result: void | Promise<void>;
    try {
      result = this.raw.kill?.();
    } catch (error) {
      this.notifyExit();
      throw error;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      return Promise.resolve(result).then(() => {
        this.notifyExit(this.exitCode);
      });
    }
    this.notifyExit(this.exitCode);
  }

  /** Wait for the stream reader to stop, without making callers depend on it. */
  async wait(): Promise<void> {
    await this.waitPromise;
    await Promise.all(
      [this.readLoopPromise, this.stderrLoopPromise].filter(
        (task): task is Promise<void> => Boolean(task),
      ),
    );
  }

  getDiagnostics(): string {
    return this.diagnosticBuffer
      .replace(/\s+/g, " ")
      .trim()
      .slice(-MAX_DIAGNOSTIC_LENGTH);
  }

  private startReadLoop(): void {
    if (typeof this.raw.stdout?.readString !== "function") return;
    this.readLoopPromise = this.readLoop();
    void this.readLoopPromise.catch(async () => {
      // Zotero InputPipe may reject at EOF instead of returning an empty
      // string. Let raw.wait() publish the authoritative exit code first.
      if (this.waitPromise) await this.waitPromise;
      this.closed = true;
      this.notifyExit(this.exitCode);
    });
  }

  private startStderrReadLoop(): void {
    if (typeof this.raw.stderr?.readString !== "function") return;
    this.stderrLoopPromise = this.readStderrLoop();
    void this.stderrLoopPromise.catch(() => undefined);
  }

  private async readStderrLoop(): Promise<void> {
    const readString = this.raw.stderr?.readString;
    if (typeof readString !== "function") return;
    while (!this.closed) {
      const rawChunk = await readString.call(this.raw.stderr);
      const chunk = this.decodeChunk(rawChunk);
      if (!chunk) break;
      this.diagnosticBuffer += this.redactDiagnosticText(chunk);
      if (this.diagnosticBuffer.length > MAX_DIAGNOSTIC_LENGTH) {
        this.diagnosticBuffer = this.diagnosticBuffer.slice(
          -MAX_DIAGNOSTIC_LENGTH,
        );
      }
    }
  }

  private startWaitLoop(): void {
    if (typeof this.raw.wait !== "function") return;
    this.waitPromise = Promise.resolve()
      .then(() => this.raw.wait?.())
      .then(async (result) => {
        const code = this.extractExitCode(result);
        this.exitCode = code;
        if (this.stderrLoopPromise) {
          await Promise.race([
            this.stderrLoopPromise.catch(() => undefined),
            new Promise<void>((resolve) =>
              setTimeout(resolve, STDERR_DRAIN_WAIT_MS),
            ),
          ]);
        }
        this.closed = true;
        this.notifyExit(code);
      })
      .catch(() => {
        this.closed = true;
        this.notifyExit(this.exitCode);
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
    if (this.waitPromise) await this.waitPromise;
    this.notifyExit(this.exitCode);
  }

  private decodeChunk(chunk: string | Uint8Array): string {
    if (typeof chunk === "string") return chunk;
    try {
      return new TextDecoder().decode(chunk);
    } catch {
      return "";
    }
  }

  private redactDiagnosticText(value: string): string {
    return value
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(/(^|[\s"'(])\/[^\s"'`)]*/g, "$1[PATH]")
      .replace(/[A-Za-z]:\\[^\s"']+/g, "[PATH]");
  }

  private extractExitCode(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const record = value && typeof value === "object" ? value : undefined;
    const code = (record as { exitCode?: unknown } | undefined)?.exitCode;
    return typeof code === "number" && Number.isFinite(code) ? code : undefined;
  }

  private notifyExit(code?: number): void {
    if (this.exitNotified) return;
    CodexAppServerProcess.activeProcesses.delete(this);
    this.exitCode = code ?? this.exitCode;
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
