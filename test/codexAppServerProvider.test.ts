import { expect } from "chai";
import { CodexAppServerProvider } from "../src/modules/llmproviders/CodexAppServerProvider";
import { CodexAppServerClient } from "../src/modules/llmproviders/codexAppServer/CodexAppServerClient";
import type { LLMOptions } from "../src/modules/llmproviders/types";

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

type FakeMode = "complete" | "hold" | "terminal-error";

/** A line-oriented process double. It deliberately has no Zotero dependency. */
class FakeJsonlProcess {
  readonly requests: JsonRpcMessage[] = [];
  killCount = 0;

  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();
  private readonly mode: FakeMode;
  private readonly pendingCustomResponses = new Map<string, JsonRpcMessage>();

  constructor(mode: FakeMode = "complete") {
    this.mode = mode;
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

  it("uses Say OK and Sol defaults for a real connection turn", async function () {
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
});
