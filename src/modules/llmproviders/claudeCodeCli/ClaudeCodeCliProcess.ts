import type {
  ClaudeCodeCliProcessLike,
  ClaudeCodeCliProcessOptions,
} from "./types";

type RawPipe = {
  write?: (data: string) => void | Promise<void>;
  close?: () => void | Promise<void>;
  end?: () => void | Promise<void>;
  readString?: () => string | Promise<string | Uint8Array>;
};

type RawSubprocess = {
  stdin?: RawPipe;
  stdout?: RawPipe;
  stderr?: RawPipe;
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
const STDOUT_DRAIN_WAIT_MS = 250;

/**
 * Deliberately fixed CLI surface. Prompt text is sent through stdin and is
 * never placed in this argument array. Keep this list in sync with the
 * restricted Claude Code contract; callers cannot append arbitrary flags.
 */
export const CLAUDE_CODE_CLI_ARGUMENTS = Object.freeze([
  "-p",
  "--output-format",
  "stream-json",
  "--permission-mode",
  "plan",
  "--restricted",
  "--no-session-persistence",
  "--max-turns",
  "1",
  "--no-chrome",
]);

function cliError(fallback: string): Error {
  return new Error(fallback);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeOptionError(detail: string): Error {
  const error = cliError(
    `Claude Code CLI option is not supported: ${detail}`,
  ) as Error & { code?: string };
  error.code = "claude-cli-invalid-options";
  return error;
}

/**
 * Zotero Subprocess adapter for one non-interactive Claude Code turn.
 *
 * The adapter intentionally exposes only line-oriented stdout, diagnostics,
 * and task-scoped termination. It does not expose a working directory,
 * environment mutation, session resume, or arbitrary command arguments.
 */
export class ClaudeCodeCliProcess implements ClaudeCodeCliProcessLike {
  private static readonly activeProcesses = new Set<ClaudeCodeCliProcess>();

  private readonly raw: RawSubprocess;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();
  private lineBuffer = "";
  private diagnosticBuffer = "";
  private closed = false;
  private exitNotified = false;
  private exitCode: number | undefined;
  private waitPromise: Promise<void> | undefined;
  private readLoopPromise: Promise<void> | undefined;
  private stderrLoopPromise: Promise<void> | undefined;
  private stderrDone = false;
  private stdinClosed = false;
  private killPromise: Promise<void> | undefined;

  constructor(rawProcess: unknown) {
    this.raw = rawProcess as RawSubprocess;
    ClaudeCodeCliProcess.activeProcesses.add(this);
    this.startWaitLoop();
    this.startReadLoop();
    this.startStderrReadLoop();
  }

  /** Wrap an existing Zotero Subprocess instance. */
  static fromSubprocess(rawProcess: unknown): ClaudeCodeCliProcess {
    return new ClaudeCodeCliProcess(rawProcess);
  }

  /** Wrap a process double without importing Zotero in tests. */
  static forTest(rawProcess: unknown): ClaudeCodeCliProcess {
    return new ClaudeCodeCliProcess(rawProcess);
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
      throw cliError("Claude Code CLI Subprocess runtime is unavailable");
    }
    return subprocess as SubprocessModule;
  }

  static async spawn(
    options: ClaudeCodeCliProcessOptions = {},
  ): Promise<ClaudeCodeCliProcess> {
    this.assertSafeOptions(options);
    const subprocess = await this.loadSubprocessModule();
    const command = await this.resolveExecutablePath(subprocess, options);
    const raw = await subprocess.call({
      command,
      arguments: [...CLAUDE_CODE_CLI_ARGUMENTS],
      stderr: "pipe",
    });
    if (!raw) {
      throw cliError("Claude Code CLI process could not be started");
    }
    return new ClaudeCodeCliProcess(raw);
  }

  /** Best-effort termination for every task-scoped CLI process. */
  static cleanup(): void {
    for (const process of Array.from(this.activeProcesses)) {
      try {
        const result = process.kill();
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // One failed kill must not prevent other task processes from stopping.
      }
    }
  }

  static cleanupAll(): void {
    this.cleanup();
  }

  write(data: string): void | Promise<void> {
    if (this.closed) {
      throw cliError("Claude Code CLI process is closed");
    }
    if (typeof this.raw.stdin?.write !== "function") {
      throw cliError("Claude Code CLI stdin is unavailable");
    }
    return this.raw.stdin.write(data);
  }

  /** Close stdin so `claude -p` receives exactly one complete text turn. */
  closeStdin(): void | Promise<void> {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    const close = this.raw.stdin?.close || this.raw.stdin?.end;
    if (typeof close !== "function") return;
    return close.call(this.raw.stdin);
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
    if (this.exitNotified) return;
    if (this.killPromise) return this.killPromise;
    let result: void | Promise<void>;
    let killError: unknown;
    try {
      result = this.raw.kill?.();
    } catch (error) {
      result = undefined;
      killError = error;
    }

    const killCompletion = Promise.resolve(result).catch((error) => {
      killError = error;
    });
    this.killPromise = (async () => {
      await Promise.race([
        killCompletion,
        new Promise<void>((resolve) =>
          setTimeout(resolve, STDOUT_DRAIN_WAIT_MS),
        ),
      ]);
      await this.waitForStdoutDrain();
      await this.waitForStderrDrain();
      this.closed = true;
      this.notifyExit(this.exitCode);
      if (killError) throw killError;
    })();
    return this.killPromise;
  }

  /** Wait for process wait/read loops, chiefly useful to lifecycle callers. */
  async wait(): Promise<void> {
    await this.waitPromise;
    await this.waitForStdoutDrain();
    await this.waitForStderrDrain();
  }

  /** Return bounded, path/token-redacted stderr diagnostics. */
  getDiagnostics(redactions: readonly string[] = []): string {
    let value = this.redactDiagnosticText(this.diagnosticBuffer);
    const unique = Array.from(
      new Set(redactions.filter((item) => typeof item === "string" && item)),
    ).sort((a, b) => b.length - a.length);
    for (const secret of unique) {
      value = value.split(secret).join("[REDACTED]");
    }
    return value.replace(/\s+/g, " ").trim().slice(-MAX_DIAGNOSTIC_LENGTH);
  }

  private static assertSafeOptions(options: ClaudeCodeCliProcessOptions): void {
    const permissionMode = options.claudePermissionMode;
    if (permissionMode !== undefined && permissionMode !== "plan") {
      throw safeOptionError("only plan permission mode is allowed");
    }
    const outputFormat = options.claudeOutputFormat;
    if (outputFormat !== undefined && outputFormat !== "stream-json") {
      throw safeOptionError("only stream-json output is allowed");
    }
    if (options.claudeRestricted === false) {
      throw safeOptionError("restricted mode cannot be disabled");
    }
  }

  private static async resolveExecutablePath(
    subprocess: SubprocessModule,
    options: ClaudeCodeCliProcessOptions,
  ): Promise<string> {
    const configured =
      asTrimmedString(options.claudeBinaryPath) ||
      asTrimmedString(options.binaryPath) ||
      "claude";
    if (this.isAbsolutePath(configured)) return configured;
    if (typeof subprocess.pathSearch !== "function") {
      throw cliError("Claude Code CLI executable path search is unavailable");
    }
    const searched = await subprocess.pathSearch(configured);
    if (!searched || !this.isAbsolutePath(searched)) {
      throw cliError("Claude Code CLI executable was not found");
    }
    return searched;
  }

  private static isAbsolutePath(value: string): boolean {
    return (
      /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
    );
  }

  private startWaitLoop(): void {
    if (typeof this.raw.wait !== "function") return;
    this.waitPromise = Promise.resolve()
      .then(() => this.raw.wait?.())
      .then(async (result) => {
        this.exitCode = this.extractExitCode(result);
        await this.waitForStdoutDrain();
        await this.waitForStderrDrain();
        this.closed = true;
        this.notifyExit(this.exitCode);
      })
      .catch(async () => {
        await this.waitForStdoutDrain();
        await this.waitForStderrDrain();
        this.closed = true;
        this.notifyExit(this.exitCode);
      });
  }

  private startReadLoop(): void {
    if (typeof this.raw.stdout?.readString !== "function") return;
    this.readLoopPromise = this.readLoop();
    void this.readLoopPromise.then(
      () => {
        if (!this.waitPromise) void this.notifyAfterStreams();
      },
      () => {
        // When raw.wait exists it owns exit ordering. Without raw.wait, the
        // stdout reader is the only process-lifecycle signal available.
        if (!this.waitPromise) void this.notifyAfterStreams();
      },
    );
  }

  private startStderrReadLoop(): void {
    if (typeof this.raw.stderr?.readString !== "function") {
      this.stderrDone = true;
      return;
    }
    this.stderrLoopPromise = this.readStderrLoop();
    void this.stderrLoopPromise.catch(() => {
      this.stderrDone = true;
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
            // Consumer failures must not terminate stdout draining.
          }
        }
      }
    }

    if (this.lineBuffer.trim()) {
      for (const listener of this.lineListeners) {
        try {
          listener(this.lineBuffer);
        } catch {
          // Ignore listener failures while flushing the final partial line.
        }
      }
      this.lineBuffer = "";
    }
  }

  private async readStderrLoop(): Promise<void> {
    const readString = this.raw.stderr?.readString;
    if (typeof readString !== "function") return;
    try {
      while (true) {
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
    } finally {
      this.stderrDone = true;
    }
  }

  private async waitForStderrDrain(): Promise<void> {
    if (this.stderrDone || !this.stderrLoopPromise) return;
    await Promise.race([
      this.stderrLoopPromise.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, STDERR_DRAIN_WAIT_MS)),
    ]);
  }

  private async waitForStdoutDrain(): Promise<void> {
    if (!this.readLoopPromise) return;
    await Promise.race([
      this.readLoopPromise.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, STDOUT_DRAIN_WAIT_MS)),
    ]);
  }

  private async notifyAfterStreams(): Promise<void> {
    if (this.exitNotified) return;
    await this.waitForStdoutDrain();
    await this.waitForStderrDrain();
    this.closed = true;
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
      .replace(
        /((?:api[_-]?key|token|secret)\s*[:=])\s*[^\s,;]+/gi,
        "$1 [REDACTED]",
      )
      .replace(/(^|[\s"'(])\/(?:[^\s"'`)]*)/g, "$1[PATH]")
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
    ClaudeCodeCliProcess.activeProcesses.delete(this);
    this.exitCode = code ?? this.exitCode;
    this.exitNotified = true;
    for (const listener of this.exitListeners) {
      try {
        listener(this.exitCode);
      } catch {
        // Exit listeners are isolated cleanup/diagnostic hooks.
      }
    }
    this.exitListeners.clear();
  }
}

export default ClaudeCodeCliProcess;
