import { expect } from "chai";
import { ProviderRegistry } from "../src/modules/llmproviders/ProviderRegistry";
import "../src/modules/llmproviders";
import { ClaudeCodeCliProvider } from "../src/modules/llmproviders/ClaudeCodeCliProvider";
import {
  ClaudeCodeCliProcess,
  type ClaudeCodeCliProcessOptions,
} from "../src/modules/llmproviders/claudeCodeCli/ClaudeCodeCliProcess";
import type { LLMOptions } from "../src/modules/llmproviders/types";

type FakeMode =
  | "success"
  | "success-no-exit"
  | "assistant-delta"
  | "result-error"
  | "malformed"
  | "forbidden-output"
  | "hold";

type FakeProcessOptions = ClaudeCodeCliProcessOptions;

/** A deterministic process double with no Zotero or Node process dependency. */
class FakeClaudeCodeProcess {
  readonly writes: string[] = [];
  readonly options: FakeProcessOptions;
  killCount = 0;
  closedInput = false;
  diagnostics = "";

  private readonly mode: FakeMode;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();

  constructor(options: FakeProcessOptions, mode: FakeMode = "success") {
    this.options = options;
    this.mode = mode;
  }

  write(data: string): void {
    this.writes.push(data);
    if (this.mode === "hold") return;

    queueMicrotask(() => {
      if (this.mode === "result-error") {
        this.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          error: "private prompt must not be copied into diagnostics",
        });
        this.emitExit(19);
        return;
      }

      if (this.mode === "assistant-delta") {
        this.emit({
          type: "assistant",
          delta: { type: "text_delta", text: "增量" },
        });
        this.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "增量",
        });
        this.emitExit(0);
        return;
      }

      if (this.mode === "malformed") {
        this.emitRaw("not-json\n");
        return;
      }

      if (this.mode === "forbidden-output") {
        this.emit({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Bash", input: {} }],
          },
        });
        return;
      }

      this.emit({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "摘" }],
        },
      });
      this.emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "要" },
        },
      });
      this.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "摘要",
        session_id: "session-never-used-for-resume",
      });
      if (this.mode !== "success-no-exit") this.emitExit(0);
    });
  }

  closeStdin(): void {
    this.closedInput = true;
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (code?: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  kill(): void {
    this.killCount += 1;
  }

  getDiagnostics(): string {
    return this.diagnostics;
  }

  emitExit(code?: number): void {
    for (const listener of this.exitListeners) listener(code);
  }

  private emit(value: Record<string, unknown>): void {
    const line = `${JSON.stringify(value)}\n`;
    this.emitRaw(line);
  }

  private emitRaw(line: string): void {
    for (const listener of this.lineListeners) listener(line);
  }
}

function expectRejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("Expected promise to reject");
    },
    (error) => (error instanceof Error ? error : new Error(String(error))),
  );
}

function waitForWrite(fake: FakeClaudeCodeProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (fake.writes.length > 0) {
        resolve();
        return;
      }
      if (Date.now() - started > 250) {
        reject(new Error("Timed out waiting for fake stdin write"));
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

describe("restricted Claude Code CLI provider", function () {
  it("constructs the exact restricted non-interactive CLI argument allowlist", async function () {
    const calls: Array<{
      command: string;
      arguments: string[];
      stderr: "pipe";
    }> = [];
    const originalChromeUtils = (globalThis as any).ChromeUtils;
    (globalThis as any).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          pathSearch: async (command: string) => {
            expect(command).to.equal("claude");
            return "/usr/local/bin/claude";
          },
          call: async (options: {
            command: string;
            arguments: string[];
            stderr: "pipe";
          }) => {
            calls.push(options);
            return {
              stdin: { write: () => {}, close: () => {} },
              stdout: { readString: async () => "" },
              stderr: { readString: async () => "" },
              wait: async () => ({ exitCode: 0 }),
              kill: () => {},
            };
          },
        },
      }),
    };

    try {
      const process = await ClaudeCodeCliProcess.spawn({
        claudeBinaryPath: "claude",
        claudePermissionMode: "plan",
        claudeRestricted: true,
        claudeOutputFormat: "stream-json",
      });
      expect(calls).to.deep.equal([
        {
          command: "/usr/local/bin/claude",
          arguments: [
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
          ],
          stderr: "pipe",
        },
      ]);
      process.kill();
    } finally {
      (globalThis as any).ChromeUtils = originalChromeUtils;
    }
  });

  it("frames one text prompt on stdin, closes stdin, streams assistant deltas, and returns final result", async function () {
    let fake: FakeClaudeCodeProcess | undefined;
    const provider = new ClaudeCodeCliProvider((options) => {
      fake = new FakeClaudeCodeProcess(options);
      return fake;
    });
    const chunks: string[] = [];

    const result = await provider.generateSummary(
      "正文",
      false,
      "请总结",
      { model: "sonnet", requestTimeoutMs: 1000 },
      (chunk) => chunks.push(chunk),
    );

    expect(result).to.equal("摘要");
    expect(chunks.join("")).to.equal("摘要");
    expect(fake?.writes).to.have.length(1);
    expect(fake?.writes[0]).to.include("正文");
    expect(fake?.writes[0]).to.match(/\n$/);
    expect(fake?.writes[0]).not.to.match(/^\s*\{/);
    expect(fake?.closedInput).to.equal(true);
  });

  it("extracts an assistant text delta object from stream-json", async function () {
    const fake = new FakeClaudeCodeProcess({}, "assistant-delta");
    const provider = new ClaudeCodeCliProvider(() => fake);
    const chunks: string[] = [];

    const result = await provider.generateSummary(
      "正文",
      false,
      undefined,
      {},
      (chunk) => {
        chunks.push(chunk);
      },
    );

    expect(result).to.equal("增量");
    expect(chunks).to.deep.equal(["增量"]);
  });

  it("returns a successful final result without waiting for a second session turn or exit callback", async function () {
    const fake = new FakeClaudeCodeProcess({}, "success-no-exit");
    const provider = new ClaudeCodeCliProvider(() => fake);

    const result = await provider.testConnection({ requestTimeoutMs: 20 });

    expect(result).to.equal("摘要");
    expect(fake.killCount).to.equal(1);
  });

  it("fails closed on malformed or tool-bearing stream output", async function () {
    const malformedFake = new FakeClaudeCodeProcess({}, "malformed");
    const malformedProvider = new ClaudeCodeCliProvider(() => malformedFake);
    const malformedError = await expectRejection(
      malformedProvider.testConnection({ requestTimeoutMs: 1000 }),
    );
    expect((malformedError as Error & { code?: string }).code).to.equal(
      "claude-cli-malformed-response",
    );
    expect(malformedFake.killCount).to.equal(1);

    const toolFake = new FakeClaudeCodeProcess({}, "forbidden-output");
    const toolProvider = new ClaudeCodeCliProvider(() => toolFake);
    const toolError = await expectRejection(
      toolProvider.testConnection({ requestTimeoutMs: 1000 }),
    );
    expect(toolError.message).to.match(/unsupported|tool/i);
    expect((toolError as Error & { code?: string }).code).to.equal(
      "claude-cli-unsupported-output",
    );
    expect(toolFake.killCount).to.equal(1);
  });

  it("does not pass session, MCP, or command/file capabilities through the process options", async function () {
    let fake: FakeClaudeCodeProcess | undefined;
    const provider = new ClaudeCodeCliProvider((options) => {
      fake = new FakeClaudeCodeProcess(options);
      return fake;
    });

    await provider.testConnection({ model: "sonnet" });

    expect(fake?.options).to.deep.equal({
      claudeBinaryPath: undefined,
      claudePermissionMode: undefined,
      claudeRestricted: undefined,
      claudeOutputFormat: undefined,
    });
    expect(fake?.writes[0]).to.include("Say OK");
    expect(fake?.writes[0]).not.to.include("resume");
    expect(fake?.writes[0]).not.to.include("session_id");
  });

  it("rejects Base64 input and MCP before spawning a process", async function () {
    let spawnCount = 0;
    const provider = new ClaudeCodeCliProvider(() => {
      spawnCount += 1;
      return new FakeClaudeCodeProcess({});
    });

    const base64Error = await expectRejection(
      provider.generateSummary("JVBERi0xLjQK", true, undefined, {}),
    );
    expect(base64Error.message).to.match(/base64|unsupported/i);

    const mcpError = await expectRejection(
      provider.generateSummary("text", false, undefined, {
        mcpEnabled: true,
      }),
    );
    expect(mcpError.message).to.match(/mcp|unsupported|disabled/i);
    expect(spawnCount).to.equal(0);
  });

  it("fails closed when a caller tries to disable restricted plan-only settings", async function () {
    let spawnCount = 0;
    const provider = new ClaudeCodeCliProvider(() => {
      spawnCount += 1;
      return new FakeClaudeCodeProcess({});
    });

    const error = await expectRejection(
      provider.testConnection({
        claudeRestricted: false,
        claudePermissionMode: "plan",
        claudeOutputFormat: "stream-json",
      }),
    );
    expect(error.message).to.match(/restricted|plan|unsupported/i);
    expect(spawnCount).to.equal(0);
  });

  it("redacts prompt text from CLI errors and preserves the process exit code", async function () {
    const secret = "PRIVATE-PROMPT-DO-NOT-ECHO";
    let fake: FakeClaudeCodeProcess | undefined;
    const provider = new ClaudeCodeCliProvider((options) => {
      fake = new FakeClaudeCodeProcess(options, "result-error");
      fake.diagnostics = `fatal: ${secret}`;
      return fake;
    });

    const error = await expectRejection(
      provider.generateSummary(secret, false, undefined, {
        requestTimeoutMs: 1000,
      }),
    );
    expect(error.message).not.to.include(secret);
    expect(error.message).to.include("fatal");
    expect((error as Error & { exitCode?: number }).exitCode).to.equal(19);
    expect((error as Error & { code?: string }).code).to.match(/claude/i);
  });

  it("drains and redacts stderr when the Zotero subprocess exits", async function () {
    let stderrRead = false;
    const observed: { code?: number; diagnostics?: string } = {};
    const raw = {
      stdin: { write: () => {}, close: () => {} },
      stdout: { readString: async () => "" },
      stderr: {
        readString: async () => {
          if (stderrRead) return "";
          stderrRead = true;
          return "fatal /Users/alater/private.pdf Bearer secret-token token=private";
        },
      },
      wait: async () => ({ exitCode: 23 }),
      kill: () => {},
    };
    const process = new ClaudeCodeCliProcess(raw);
    await new Promise<void>((resolve) => {
      process.onExit((code) => {
        observed.code = code;
        observed.diagnostics = process.getDiagnostics?.();
        resolve();
      });
    });

    expect(observed.code).to.equal(23);
    expect(observed.diagnostics).to.contain("fatal");
    expect(observed.diagnostics).not.to.contain("/Users/alater/private.pdf");
    expect(observed.diagnostics).not.to.contain("secret-token");
    expect(observed.diagnostics).not.to.contain("private");
  });

  it("waits for delayed stdout and flushes a final partial JSONL line before exit", async function () {
    let releaseStdout!: (value: string) => void;
    let resolveRawWait!: (value: { exitCode: number }) => void;
    let stdoutReads = 0;
    const stdoutReady = new Promise<string>((resolve) => {
      releaseStdout = resolve;
    });
    const rawWait = new Promise<{ exitCode: number }>((resolve) => {
      resolveRawWait = resolve;
    });
    const raw = {
      stdout: {
        readString: async () => {
          if (stdoutReads++ === 0) return stdoutReady;
          return "";
        },
      },
      wait: async () => rawWait,
      kill: () => {},
    };
    const process = new ClaudeCodeCliProcess(raw);
    const lines: string[] = [];
    const exitCodes: Array<number | undefined> = [];
    process.onLine((line) => lines.push(line));
    process.onExit((code) => exitCodes.push(code));

    try {
      resolveRawWait({ exitCode: 0 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(exitCodes).to.deep.equal([]);

      releaseStdout('{"type":"result","result":"late"}');
      await process.wait();
      expect(lines).to.deep.equal(['{"type":"result","result":"late"}']);
      expect(exitCodes).to.deep.equal([0]);
    } finally {
      releaseStdout("");
      await process.wait();
    }
  });

  it("waits for delayed stdout before notifying exit after kill", async function () {
    let releaseStdout!: (value: string) => void;
    let stdoutReads = 0;
    const stdoutReady = new Promise<string>((resolve) => {
      releaseStdout = resolve;
    });
    const raw = {
      stdout: {
        readString: async () => {
          if (stdoutReads++ === 0) return stdoutReady;
          return "";
        },
      },
      kill: () => {},
    };
    const process = new ClaudeCodeCliProcess(raw);
    const lines: string[] = [];
    const exitCodes: Array<number | undefined> = [];
    process.onLine((line) => lines.push(line));
    process.onExit((code) => exitCodes.push(code));
    const killing = Promise.resolve(process.kill());

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(exitCodes).to.deep.equal([]);

      releaseStdout('{"type":"result","result":"killed-late"}');
      await killing;
      expect(lines).to.deep.equal(['{"type":"result","result":"killed-late"}']);
      expect(exitCodes).to.deep.equal([undefined]);
    } finally {
      releaseStdout("");
      await process.wait();
    }
  });

  it("bounds exit notification when raw.wait rejects and stdout never reaches EOF", async function () {
    const raw = {
      stdout: {
        readString: async () => new Promise<string>(() => undefined),
      },
      wait: async () => {
        throw new Error("wait failed");
      },
      kill: () => {},
    };
    const process = new ClaudeCodeCliProcess(raw);
    let exitCount = 0;
    const exited = new Promise<void>((resolve) => {
      process.onExit(() => {
        exitCount += 1;
        resolve();
      });
    });

    const observedInTime = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(observedInTime).to.equal(true);
    expect(exitCount).to.equal(1);
    await process.kill();
  });

  it("keeps kill and exit notification idempotent", async function () {
    let killCount = 0;
    const raw = {
      stdout: { readString: async () => "" },
      kill: () => {
        killCount += 1;
      },
    };
    const process = new ClaudeCodeCliProcess(raw);
    let exitCount = 0;
    process.onExit(() => {
      exitCount += 1;
    });

    await Promise.all([
      Promise.resolve(process.kill()),
      Promise.resolve(process.kill()),
    ]);
    expect(killCount).to.equal(1);
    expect(exitCount).to.equal(1);
  });

  it("kills a task-scoped process on abort and timeout", async function () {
    const abortFake = new FakeClaudeCodeProcess({}, "hold");
    const abortProvider = new ClaudeCodeCliProvider(() => abortFake);
    const controller = new AbortController();
    const pendingAbort = abortProvider.testConnection({
      abortSignal: controller.signal,
      requestTimeoutMs: 1000,
    });
    await waitForWrite(abortFake);
    controller.abort();
    const abortError = await expectRejection(pendingAbort);
    expect(abortError.name).to.match(/abort/i);
    expect(abortFake.killCount).to.equal(1);

    const timeoutFake = new FakeClaudeCodeProcess({}, "hold");
    const timeoutProvider = new ClaudeCodeCliProvider(() => timeoutFake);
    const timeoutError = await expectRejection(
      timeoutProvider.testConnection({ requestTimeoutMs: 5 }),
    );
    expect(timeoutError.message).to.match(/timed out|timeout/i);
    expect(timeoutFake.killCount).to.equal(1);
  });

  it("registers the Claude CLI provider without replacing existing providers", function () {
    expect(ProviderRegistry.get("openai")?.id).to.equal("openai");
    expect(ProviderRegistry.get("codex-app-server")?.id).to.equal(
      "codex-app-server",
    );
    expect(ProviderRegistry.get("claude-code-cli")?.id).to.equal(
      "claude-code-cli",
    );
  });
});
