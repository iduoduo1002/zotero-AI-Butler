import { expect } from "chai";
import { CodexAppServerProvider } from "../src/modules/llmproviders/CodexAppServerProvider";
import { CodexAppServerClient } from "../src/modules/llmproviders/codexAppServer/CodexAppServerClient";
import { CodexAppServerProcess } from "../src/modules/llmproviders/codexAppServer/CodexAppServerProcess";
import type { LLMOptions } from "../src/modules/llmproviders/types";

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

type FakeMode =
  "complete" | "hold" | "terminal-error" | "delay-turn-start" | "rpc-error";

/** A line-oriented process double. It deliberately has no Zotero dependency. */
class FakeJsonlProcess {
  readonly requests: JsonRpcMessage[] = [];
  killCount = 0;

  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();
  private readonly mode: FakeMode;
  private readonly strictInput: boolean;
  private readonly pendingCustomResponses = new Map<string, JsonRpcMessage>();

  constructor(mode: FakeMode = "complete", strictInput = false) {
    this.mode = mode;
    this.strictInput = strictInput;
  }

  write(line: string): void {
    const request = JSON.parse(line) as JsonRpcMessage;
    this.requests.push(request);

    if (request.method === "initialize") {
      this.emit({ id: request.id, result: { userAgent: "fake" } });
      return;
    }
    if (request.method === "initialized") return;
    if (request.method === "thread/start") {
      this.emit({ id: request.id, result: { thread: { id: "thr-1" } } });
      return;
    }
    if (request.method === "turn/interrupt") {
      this.emit({ id: request.id, result: {} });
      return;
    }
    if (request.method === "turn/start") {
      const input = request.params?.input;
      const textInput = Array.isArray(input) ? input[0] : undefined;
      if (
        this.strictInput &&
        (!textInput ||
          typeof textInput !== "object" ||
          !Array.isArray((textInput as Record<string, unknown>).text_elements))
      ) {
        this.emit({
          id: request.id,
          error: { code: -32602, message: "text_elements is required" },
        });
        return;
      }
      if (this.mode === "rpc-error") {
        const text =
          textInput && typeof textInput === "object"
            ? String((textInput as Record<string, unknown>).text || "")
            : "";
        this.emit({
          id: request.id,
          error: {
            code: -32602,
            message: `server echoed private input: ${text}`,
          },
        });
        return;
      }
      if (this.mode === "delay-turn-start") return;
      this.emit({ id: request.id, result: { turn: { id: "turn-1" } } });
      if (this.mode === "complete") {
        this.emit({
          method: "item/agentMessage/delta",
          params: { turnId: "turn-1", delta: "摘" },
        });
        this.emit({
          method: "item/agentMessage/delta",
          params: { turnId: "turn-1", delta: "要" },
        });
        this.emit({
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed" } },
        });
      } else if (this.mode === "terminal-error") {
        this.emit({
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "interrupted" } },
        });
      }
      return;
    }
    if (request.method === "custom/one" || request.method === "custom/two") {
      this.pendingCustomResponses.set(request.method, {
        id: request.id,
        result: request.method === "custom/one" ? "one" : "two",
      });
      if (
        this.pendingCustomResponses.has("custom/one") &&
        this.pendingCustomResponses.has("custom/two")
      ) {
        this.emit(this.pendingCustomResponses.get("custom/two")!);
        this.emit(this.pendingCustomResponses.get("custom/one")!);
      }
    }
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
    this.emitExit();
  }

  emitExit(code?: number): void {
    for (const listener of this.exitListeners) listener(code);
  }

  private emit(message: JsonRpcMessage): void {
    const line = `${JSON.stringify(message)}\n`;
    queueMicrotask(() => {
      for (const listener of this.lineListeners) listener(line);
    });
  }
}

function requestMethods(fake: FakeJsonlProcess): string[] {
  return fake.requests
    .filter((request) => request.id !== undefined)
    .map((request) => request.method || "");
}

async function waitForRequest(
  fake: FakeJsonlProcess,
  method: string,
): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (fake.requests.some((request) => request.method === method)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for fake request ${method}`);
}

async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected promise to reject");
}

describe("Codex app-server provider", function () {
  it("runs initialize, thread/start, and turn/start and streams final text", async function () {
    const fake = new FakeJsonlProcess();
    const result = await new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "请输出摘要",
      executionId: "exec-1",
    });

    expect(result.text).to.equal("摘要");
    expect(result.threadId).to.equal("thr-1");
    expect(result.turnId).to.equal("turn-1");
    expect(requestMethods(fake)).to.deep.equal([
      "initialize",
      "thread/start",
      "turn/start",
    ]);
    expect(fake.requests.find((request) => request.method === "initialized")).to
      .exist;
  });

  it("sends the generated Codex text input shape with text_elements", async function () {
    const fake = new FakeJsonlProcess("complete", true);
    const result = await new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "严格协议",
      executionId: "exec-strict-input",
    });

    expect(result.text).to.equal("摘要");
    const turn = fake.requests.find(
      (request) => request.method === "turn/start",
    );
    const input = turn?.params?.input;
    expect(input).to.be.an("array");
    expect((input as Array<Record<string, unknown>>)[0]).to.include({
      type: "text",
      text: "严格协议",
    });
    expect(
      (input as Array<Record<string, unknown>>)[0].text_elements,
    ).to.deep.equal([]);
  });

  it("matches concurrent response ids even when responses arrive out of order", async function () {
    const fake = new FakeJsonlProcess();
    const client = new CodexAppServerClient(fake as any);
    await client.runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "warm up",
      executionId: "exec-warmup",
    });

    const [one, two] = await Promise.all([
      client.request("custom/one"),
      client.request("custom/two"),
    ]);
    expect(one).to.equal("one");
    expect(two).to.equal("two");
  });

  it("forwards deltas to onEvent and concatenates only the final assistant text", async function () {
    const fake = new FakeJsonlProcess();
    const events: Array<{ method: string; params?: { delta?: string } }> = [];
    const result = await new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "请输出摘要",
      executionId: "exec-events",
      onEvent: (event) => {
        events.push(event as { method: string; params?: { delta?: string } });
      },
    });

    expect(
      events
        .filter((event) => event.method === "item/agentMessage/delta")
        .map((event) => event.params?.delta),
    ).to.deep.equal(["摘", "要"]);
    expect(result.text).to.equal("摘要");
  });

  it("sends turn/interrupt and rejects with AbortError when aborted", async function () {
    const fake = new FakeJsonlProcess("hold");
    const controller = new AbortController();
    const pending = new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "不会输出",
      executionId: "exec-abort",
      abortSignal: controller.signal,
    });
    await waitForRequest(fake, "turn/start");
    controller.abort();

    const error = await expectRejection(pending);
    expect(error.name).to.equal("AbortError");
    expect(requestMethods(fake)).to.include("turn/interrupt");
  });

  it("kills the task process when aborted before turn/start returns an id", async function () {
    const fake = new FakeJsonlProcess("delay-turn-start");
    const controller = new AbortController();
    const pending = new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "race input",
      executionId: "exec-abort-race",
      abortSignal: controller.signal,
    });
    await waitForRequest(fake, "turn/start");
    controller.abort();

    const error = await expectRejection(pending);
    expect(error.name).to.equal("AbortError");
    expect(fake.killCount).to.equal(1);
  });

  it("kills the task process after turn timeout", async function () {
    const fake = new FakeJsonlProcess("hold");
    const pending = new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "不会输出",
      executionId: "exec-timeout",
      timeoutMs: 5,
    });

    const error = await expectRejection(pending);
    expect(error.message).to.match(/timed out/i);
    expect(fake.killCount).to.equal(1);
  });

  it("rejects non-completed terminal status without leaking input text", async function () {
    const fake = new FakeJsonlProcess("terminal-error");
    const input = "private paper text that must not appear";
    const pending = new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input,
      executionId: "exec-terminal-error",
    });

    const error = await expectRejection(pending);
    expect(error.message).to.contain("turn-1");
    expect(error.message).not.to.contain(input);
  });

  it("does not leak input text from a JSON-RPC error response", async function () {
    const fake = new FakeJsonlProcess("rpc-error");
    const input = "secret input echoed by an unsafe server";
    const error = await expectRejection(
      new CodexAppServerClient(fake as any).runTurn({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        input,
        executionId: "exec-rpc-error",
      }),
    );

    expect(error.message).not.to.contain(input);
  });

  it("fails closed when MCP is explicitly enabled but not configured by this runtime", async function () {
    const fake = new FakeJsonlProcess();
    const error = await expectRejection(
      new CodexAppServerClient(fake as any).runTurn({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        input: "no MCP",
        executionId: "exec-mcp",
        mcpEnabled: true,
      }),
    );

    expect(error.message).to.match(/mcp|reserved|unsupported/i);
    expect(fake.requests).to.deep.equal([]);
  });

  it("rejects invalid policy values before opening the protocol", async function () {
    const fake = new FakeJsonlProcess();
    const error = await expectRejection(
      new CodexAppServerClient(fake as any).runTurn({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        input: "invalid policy",
        executionId: "exec-policy",
        approvalPolicy: "always-allow" as any,
      }),
    );

    expect(error.message).to.match(/approval|policy|invalid/i);
    expect(fake.requests).to.deep.equal([]);
  });

  it("serializes valid approval, sandbox, and network policies explicitly", async function () {
    const fake = new FakeJsonlProcess();
    await new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "policy input",
      executionId: "exec-policy-valid",
      approvalPolicy: {
        granular: {
          sandboxApproval: true,
          rules: false,
          skillApproval: true,
          requestPermissions: false,
          mcpElicitations: false,
        },
      },
      sandboxPolicy: "read-only",
      networkAccess: true,
      mcpEnabled: false,
    });

    const thread = fake.requests.find(
      (request) => request.method === "thread/start",
    );
    const turn = fake.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(thread?.params?.sandbox).to.equal("read-only");
    expect(thread?.params?.approvalPolicy).to.deep.equal({
      granular: {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: false,
        mcp_elicitations: false,
      },
    });
    expect(turn?.params?.sandboxPolicy).to.deep.equal({
      type: "readOnly",
      networkAccess: true,
    });
    expect(turn?.params?.clientUserMessageId).to.equal("exec-policy-valid");
  });

  it("rejects pending protocol calls when the process exits", async function () {
    const fake = new FakeJsonlProcess("hold");
    const pending = new CodexAppServerClient(fake as any).runTurn({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: "不会输出",
      executionId: "exec-exit",
    });
    await waitForRequest(fake, "initialize");
    fake.emitExit(1);
    const error = await expectRejection(pending);
    expect(error.message).to.match(/process exited|closed/i);
  });

  it("rejects Base64 input and streams text prompts through the Provider", async function () {
    const fake = new FakeJsonlProcess();
    const client = new CodexAppServerClient(fake as any);
    const provider = new CodexAppServerProvider(() => client);
    const chunks: string[] = [];
    const options: LLMOptions = {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      executionId: "exec-provider",
    };

    const base64Error = await expectRejection(
      provider.generateSummary("YmFzZTY0", true, "prompt", options),
    );
    expect(base64Error.message).to.match(/base64|unsupported/i);
    const result = await provider.generateSummary(
      "正文",
      false,
      "请总结",
      options,
      (chunk) => {
        chunks.push(chunk);
      },
    );

    expect(result).to.equal("摘要");
    expect(chunks.join("")).to.equal("摘要");
    const turn = fake.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(JSON.stringify(turn?.params)).to.contain("<Paper>");
    expect(JSON.stringify(turn?.params)).to.contain("正文");
  });

  it("uses Say OK and Sol defaults for a connection turn through the fake protocol", async function () {
    const fake = new FakeJsonlProcess();
    const provider = new CodexAppServerProvider(
      () => new CodexAppServerClient(fake as any),
    );

    const result = await provider.testConnection({});

    expect(result).to.equal("摘要");
    const turn = fake.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(turn?.params?.model).to.equal("gpt-5.6-sol");
    expect(turn?.params?.effort).to.equal("high");
    expect(JSON.stringify(turn?.params)).to.contain("Say OK");
  });

  it("passes thread/turn metadata to the optional Provider side channel", async function () {
    const fake = new FakeJsonlProcess();
    const provider = new CodexAppServerProvider(
      () => new CodexAppServerClient(fake as any),
    );
    const results: Array<{
      threadId: string;
      turnId: string;
      diagnostics: number;
    }> = [];

    const text = await provider.generateSummary("正文", false, "请总结", {
      executionId: "exec-metadata",
      onCodexTurnResult: (result) => {
        results.push({
          threadId: result.threadId,
          turnId: result.turnId,
          diagnostics: result.diagnostics.length,
        });
      },
    });

    expect(text).to.equal("摘要");
    expect(results).to.deep.equal([
      { threadId: "thr-1", turnId: "turn-1", diagnostics: 3 },
    ]);
  });

  it("resolves a bare Codex command before calling Zotero Subprocess", async function () {
    const calls: Array<{ command: string; arguments: string[] }> = [];
    let pathSearchCalls = 0;
    const originalChromeUtils = (globalThis as any).ChromeUtils;
    (globalThis as any).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          pathSearch: async (command: string) => {
            pathSearchCalls += 1;
            expect(command).to.equal("codex");
            return "/usr/local/bin/codex";
          },
          call: async (options: { command: string; arguments: string[] }) => {
            calls.push(options);
            expect(options.command).to.match(/^\//);
            return { stdin: { write: () => {} }, kill: () => {} };
          },
        },
      }),
    };

    try {
      const process = await CodexAppServerProcess.spawn();
      expect(pathSearchCalls).to.equal(1);
      expect(calls).to.have.length(1);
      expect(calls[0]).to.include({
        command: "/usr/local/bin/codex",
        stderr: "pipe",
      });
      expect(calls[0].arguments).to.deep.equal(["app-server"]);
      process.kill();
    } finally {
      (globalThis as any).ChromeUtils = originalChromeUtils;
    }
  });

  it("adds verified macOS Node directories while preserving the inherited PATH", async function () {
    let callOptions: Record<string, unknown> | undefined;
    const originalChromeUtils = (globalThis as any).ChromeUtils;
    const originalNavigator = (globalThis as any).navigator;
    const originalServices = (globalThis as any).Services;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "MacIntel" },
    });
    (globalThis as any).Services = { env: { get: () => "/gui/bin" } };
    (globalThis as any).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          pathSearch: async () => "/Users/alater/.npm-global/bin/codex",
          call: async (options: Record<string, unknown>) => {
            callOptions = options;
            return { stdin: { write: () => {} }, kill: () => {} };
          },
        },
      }),
    };

    try {
      const process = await CodexAppServerProcess.spawn();
      const environment = callOptions?.environment as { PATH: string };
      expect(callOptions?.environmentAppend).to.equal(true);
      expect(environment.PATH).to.equal(
        "/usr/local/bin:/opt/homebrew/bin:/gui/bin",
      );
      process.kill();
    } finally {
      (globalThis as any).ChromeUtils = originalChromeUtils;
      (globalThis as any).Services = originalServices;
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
    }
  });

  it("does not override the environment on non-macOS", async function () {
    let callOptions: Record<string, unknown> | undefined;
    const originalChromeUtils = (globalThis as any).ChromeUtils;
    const originalNavigator = (globalThis as any).navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "Linux x86_64" },
    });
    (globalThis as any).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          pathSearch: async () => "/usr/bin/codex",
          call: async (options: Record<string, unknown>) => {
            callOptions = options;
            return { stdin: { write: () => {} }, kill: () => {} };
          },
        },
      }),
    };
    try {
      const process = await CodexAppServerProcess.spawn();
      expect(callOptions).not.to.have.property("environment");
      expect(callOptions).not.to.have.property("environmentAppend");
      process.kill();
    } finally {
      (globalThis as any).ChromeUtils = originalChromeUtils;
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
    }
  });

  it("fails closed when Zotero path search cannot resolve Codex", async function () {
    const originalChromeUtils = (globalThis as any).ChromeUtils;
    (globalThis as any).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          pathSearch: async () => null,
          call: async () => {
            throw new Error("bare command must never reach call");
          },
        },
      }),
    };

    try {
      const error = await expectRejection(CodexAppServerProcess.spawn());
      expect(error.message).to.match(/codex|executable|path/i);
    } finally {
      (globalThis as any).ChromeUtils = originalChromeUtils;
    }
  });

  it("drains stderr and preserves a redacted raw.wait exit code", async function () {
    const observed: { code?: number; diagnostics?: string } = {};
    let stderrRead = false;
    const exit = new Promise<number | undefined>((resolve) => {
      const raw = {
        stdin: { write: () => {} },
        stdout: {
          readString: async () => {
            throw new Error("EOF");
          },
        },
        stderr: {
          readString: async () => {
            if (stderrRead) return "";
            stderrRead = true;
            return "fatal /Users/alater/private.pdf Bearer super-secret-token";
          },
        },
        wait: async () => ({ exitCode: 23 }),
        kill: () => {},
      };
      const process = new CodexAppServerProcess(raw);
      process.onExit((code) => {
        observed.code = code;
        observed.diagnostics = process.getDiagnostics();
        resolve(code);
      });
    });

    expect(await exit).to.equal(23);
    expect(observed.diagnostics).to.contain("fatal");
    expect(observed.diagnostics).not.to.contain("/Users/alater/private.pdf");
    expect(observed.diagnostics).not.to.contain("super-secret-token");
  });
});
