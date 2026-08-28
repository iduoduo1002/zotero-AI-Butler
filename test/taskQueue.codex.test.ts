import { expect } from "chai";
import {
  TaskQueueManager,
  TaskStatus,
  isCodexImageSummaryUnsupported,
  runCodexTaskGate,
  type CodexQueueGateOptions,
} from "../src/modules/taskQueue";
import {
  CodexTaskLedger,
  type CodexExecutionContext,
  type CodexTaskContract,
  type CodexTaskLedgerFileSystem,
} from "../src/modules/codexTaskLedger";
import LLMService from "../src/modules/llmService";
import { LLMEndpointManager } from "../src/modules/llmEndpointManager";
import { ProviderRegistry } from "../src/modules/llmproviders/ProviderRegistry";
import { CodexAppServerProcess } from "../src/modules/llmproviders/codexAppServer/CodexAppServerProcess";
import { ContentExtractor } from "../src/modules/contentExtractor";
import { NoteGenerator } from "../src/modules/noteGenerator";
import { TaskArtifacts } from "../src/modules/taskArtifacts";

class MemoryLedgerFileSystem implements CodexTaskLedgerFileSystem {
  content = "";

  async ensureDirectory(): Promise<void> {}

  async readTextFile(): Promise<string> {
    return this.content;
  }

  async appendTextFile(_path: string, text: string): Promise<void> {
    this.content += text;
  }
}

const solContext: Partial<CodexExecutionContext> = {
  role: "sol",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  itemKey: "ITEM-1",
  approvalPolicy: "on-request",
  sandboxPolicy: "read-only",
  networkAccess: false,
};

const lunaContext: Partial<CodexExecutionContext> = {
  role: "luna",
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  itemKey: "ITEM-1",
  approvalPolicy: "on-request",
  sandboxPolicy: "read-only",
  networkAccess: false,
};

const contract: CodexTaskContract = {
  executionId: "sol-plan-1",
  acceptanceCriteria: [
    "generated artifact is non-empty",
    "artifact probe passes",
  ],
  inputSummary: "one authorized Zotero item",
  outputSummary: "one summary note candidate",
};

function gateOptions(
  ledger: CodexTaskLedger,
  overrides: Partial<CodexQueueGateOptions> = {},
): CodexQueueGateOptions {
  return {
    ledger,
    solContext,
    lunaContext,
    contract,
    runLuna: async () => ({
      executionId: "luna-run-1",
      outputSummary: "summary candidate generated",
    }),
    probeArtifact: async () => ({ exists: true }),
    writeFinalNote: async () => undefined,
    ...overrides,
  };
}

describe("Codex task queue gate", function () {
  it("records Codex thread/turn diagnostics through the Provider side channel", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const prefs = new Map<string, unknown>();
    globalValue.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => {
          prefs.set(key, value);
        },
        clear: (key: string) => {
          prefs.delete(key);
        },
      },
    };
    globalValue.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) =>
              requests.map(({ id }) => ({ value: id, attributes: [] })),
          },
        },
      },
    };
    globalValue.ztoolkit = { log: () => undefined };
    const originalProvider = ProviderRegistry.get("codex-app-server");
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ledger.jsonl", {
      fileSystem,
      idFactory: () => "exec-side-channel",
    });
    const seen: any[] = [];
    ProviderRegistry.register({
      id: "codex-app-server",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: false,
        maxPdfFiles: 0,
        supportsSystemPrompt: true,
        supportedParams: ["stream", "reasoningEffort"],
      },
      generateSummary: async (_content, isBase64, _prompt, options) => {
        seen.push({ isBase64, options });
        await options.onCodexTurnResult?.({
          threadId: "thread-side",
          turnId: "turn-side",
          text: "fake summary",
          diagnostics: [{ method: "turn/completed", status: "completed" }],
          events: [{ method: "turn/completed", status: "completed" }],
        });
        return "fake summary";
      },
      chat: async () => "fake chat",
      testConnection: async () => "OK",
    } as any);
    const endpoint = LLMEndpointManager.createEndpoint(
      "codex-app-server",
      "sol",
    );
    LLMEndpointManager.saveEndpoints([endpoint]);
    LLMService.setCodexTaskLedger(ledger);

    try {
      const response = await LLMService.generate({
        task: "summary",
        content: { kind: "text", text: "safe input" },
        transport: { retry: false },
        metadata: {
          role: "luna",
          itemKey: "ITEM-1",
          attachmentKey: "ATTACH-1",
          sourceSha256: "e".repeat(64),
        },
      });

      expect(seen).to.have.length(1);
      expect(seen[0].isBase64).to.equal(false);
      expect(seen[0].options).to.include({
        role: "luna",
        model: "gpt-5.6-luna",
        approvalPolicy: "on-request",
        sandboxPolicy: "read-only",
        networkAccess: false,
      });
      expect(response).to.include({
        executionId: seen[0].options.executionId,
        role: "luna",
        threadId: "thread-side",
        turnId: "turn-side",
        sourceSha256: "e".repeat(64),
        status: "passed",
      });
      expect(
        (await ledger.findLatest({ executionId: seen[0].options.executionId }))
          ?.status,
      ).to.equal("passed");
    } finally {
      if (originalProvider) ProviderRegistry.register(originalProvider);
      LLMService.setCodexTaskLedger(null);
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("rejects Codex Base64 input before invoking the Provider", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const prefs = new Map<string, unknown>();
    globalValue.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
        clear: (key: string) => prefs.delete(key),
      },
    };
    globalValue.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) =>
              requests.map(({ id }) => ({ value: id, attributes: [] })),
          },
        },
      },
    };
    globalValue.ztoolkit = { log: () => undefined };
    const originalProvider = ProviderRegistry.get("codex-app-server");
    let providerCallCount = 0;
    ProviderRegistry.register({
      id: "codex-app-server",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: false,
        maxPdfFiles: 0,
        supportsSystemPrompt: true,
        supportedParams: ["stream", "reasoningEffort"],
      },
      generateSummary: async () => {
        providerCallCount += 1;
        return "unexpected";
      },
      chat: async () => "unexpected",
      testConnection: async () => "OK",
    } as any);
    LLMEndpointManager.saveEndpoints([
      LLMEndpointManager.createEndpoint("codex-app-server", "sol"),
    ]);
    try {
      let thrown: Error | undefined;
      try {
        await LLMService.generate({
          task: "summary",
          content: {
            kind: "legacy",
            content: "JVBERi0xLjQKprivate",
            isBase64: true,
            policy: "pdf-base64",
          },
          transport: { retry: false },
        });
      } catch (error) {
        thrown = error instanceof Error ? error : new Error(String(error));
      }
      expect(thrown?.message).to.match(/endpoint-pdf-unsupported|unsupported/i);
      expect(providerCallCount).to.equal(0);
    } finally {
      if (originalProvider) ProviderRegistry.register(originalProvider);
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("propagates role, policy, item, attachment, and source context per attempt", function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    globalValue.Zotero = {
      Prefs: {
        get: (_key: string) => undefined,
      },
    };
    globalValue.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) =>
              requests.map(({ id }) => ({ value: id, attributes: [] })),
          },
        },
      },
    };
    try {
      const endpoint = LLMEndpointManager.createEndpoint(
        "codex-app-server",
        "sol",
      );
      const prepared = (LLMService as any).buildAttemptOptions(
        endpoint,
        undefined,
        { stream: false },
        {
          role: "luna",
          itemKey: "ITEM-1",
          attachmentKey: "ATTACH-1",
          sourceSha256: "d".repeat(64),
          parentExecutionId: "sol-plan-1",
        },
      );

      expect(prepared.context).to.include({
        role: "luna",
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        itemKey: "ITEM-1",
        attachmentKey: "ATTACH-1",
        sourceSha256: "d".repeat(64),
        parentExecutionId: "sol-plan-1",
      });
      expect(prepared.options).to.include({
        role: "luna",
        model: "gpt-5.6-luna",
        executionId: prepared.context.executionId,
        parentExecutionId: "sol-plan-1",
        codexSourceSha256: "d".repeat(64),
        networkAccess: false,
        approvalPolicy: "on-request",
        sandboxPolicy: "read-only",
      });
    } finally {
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
    }
  });

  it("uses injectable Sol planning and acceptance turns around bounded Luna work", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const prefs = new Map<string, unknown>();
    globalValue.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
        clear: (key: string) => prefs.delete(key),
      },
    };
    globalValue.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) =>
              requests.map(({ id }) => ({ value: id, attributes: [] })),
          },
        },
      },
    };
    globalValue.ztoolkit = { log: () => undefined };
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ledger.jsonl", {
      fileSystem,
      idFactory: (() => {
        let index = 0;
        return () => `ledger-${++index}`;
      })(),
    });
    const originalGenerate = LLMService.generate;
    const calls: any[] = [];
    let turn = 0;
    LLMService.generate = (async (request: any) => {
      calls.push(request);
      turn += 1;
      return {
        text:
          turn === 1
            ? JSON.stringify({
                acceptanceCriteria: ["candidate and probe are valid"],
                outputSummary: "a bounded summary candidate",
              })
            : JSON.stringify({ acceptance: "PASS" }),
        providerId: "codex-app-server",
        executionId: `provider-${turn}`,
        role: "sol",
        model: "gpt-5.6-sol",
        status: "passed",
      };
    }) as any;
    LLMService.setCodexTaskLedger(ledger);
    const manager = Object.create(TaskQueueManager.prototype) as any;
    const endpoint = LLMEndpointManager.createEndpoint(
      "codex-app-server",
      "sol",
    );
    const item = {
      id: 1,
      key: "ITEM-1",
      getField: () => "Paper",
    } as unknown as Zotero.Item;
    const abortController = new AbortController();

    try {
      const execution = await manager.createCodexQueueExecution(
        {
          id: "summary-task-1",
          itemId: 1,
          title: "Paper",
          status: "pending",
          progress: 0,
          createdAt: new Date(),
          retryCount: 0,
          maxRetries: 1,
        },
        item,
        endpoint,
        abortController.signal,
      );
      const acceptance = await manager.runCodexSolAcceptance(
        execution,
        { html: "<h2>candidate</h2><p>ready</p>", content: "ready" },
        abortController.signal,
      );

      expect(calls.map((request) => request.metadata?.role)).to.deep.equal([
        "sol",
        "sol",
      ]);
      expect(
        calls.every((request) => request.transport?.retry === false),
      ).to.equal(true);
      expect(
        calls.every(
          (request) =>
            request.transport?.abortSignal === abortController.signal,
        ),
      ).to.equal(true);
      expect(calls[0].content).to.deep.include({ kind: "text" });
      expect(calls[1].content).to.deep.include({ kind: "text" });
      expect(execution.contract.acceptanceCriteria).to.deep.equal([
        "candidate and probe are valid",
      ]);
      expect(acceptance).to.deep.include({
        acceptance: "PASS",
        executionId: "provider-2",
      });
      expect(
        (await ledger.findLatest({ executionId: execution.solExecutionId }))
          ?.providerExecutionId,
      ).to.equal("provider-1");
    } finally {
      LLMService.generate = originalGenerate;
      LLMService.setCodexTaskLedger(null);
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("gates an actual queue task with Sol planning, Luna metadata, and Sol acceptance", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const prefs = new Map<string, unknown>();
    const item = {
      id: 1,
      key: "ITEM-QUEUE",
      getField: () => "Queue paper",
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    globalValue.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
        clear: (key: string) => prefs.delete(key),
      },
      Items: { getAsync: async () => item },
    };
    globalValue.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) =>
              requests.map(({ id }) => ({ value: id, attributes: [] })),
          },
        },
      },
    };
    globalValue.ztoolkit = { log: () => undefined };

    const originalProvider = ProviderRegistry.get("codex-app-server");
    const originalHasAnalyzable = ContentExtractor.hasAnalyzableAttachment;
    const originalProbe = TaskArtifacts.probe;
    const originalProbeCandidate = TaskArtifacts.probeCandidate;
    const originalGenerateNote = NoteGenerator.generateNoteForItem;
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ledger.jsonl", { fileSystem });
    const turns: string[] = [];
    let providerCall = 0;
    ProviderRegistry.register({
      id: "codex-app-server",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: false,
        maxPdfFiles: 0,
        supportsSystemPrompt: true,
        supportedParams: ["stream", "reasoningEffort"],
      },
      generateSummary: async (_content, isBase64, _prompt, options) => {
        expect(isBase64).to.equal(false);
        turns.push(options.role || "unknown");
        providerCall += 1;
        const text =
          providerCall === 1
            ? JSON.stringify({
                acceptanceCriteria: ["candidate probe passes"],
                outputSummary: "queue candidate",
              })
            : JSON.stringify({ acceptance: "PASS" });
        await options.onCodexTurnResult?.({
          threadId: `thread-${providerCall}`,
          turnId: `turn-${providerCall}`,
          text,
          diagnostics: [{ method: "turn/completed", status: "completed" }],
          events: [{ method: "turn/completed", status: "completed" }],
        });
        return text;
      },
      chat: async () => "unexpected-chat",
      testConnection: async () => "OK",
    } as any);
    LLMEndpointManager.saveEndpoints([
      LLMEndpointManager.createEndpoint("codex-app-server", "sol"),
    ]);
    LLMService.setCodexTaskLedger(ledger);
    ContentExtractor.hasAnalyzableAttachment = async () => true;
    TaskArtifacts.probeCandidate = async () => ({
      exists: true,
      reason: "candidate-ready",
    });
    TaskArtifacts.probe = async () => ({ exists: true, reason: "persisted" });
    let gateCalled = false;
    let lunaOptions: any;
    NoteGenerator.generateNoteForItem = (async (
      _item,
      _window,
      _progress,
      _stream,
      options,
    ) => {
      gateCalled = true;
      lunaOptions = options;
      await options?.noteWriteGate?.({
        html: "<h2>candidate</h2><p>ready</p>",
        content: "ready",
      });
      return { note: item, content: "ready" };
    }) as any;
    const manager = Object.create(TaskQueueManager.prototype) as any;
    manager.tasks = new Map([
      [
        "summary-task-1",
        {
          id: "summary-task-1",
          itemId: 1,
          title: "Queue paper",
          status: TaskStatus.PENDING,
          progress: 0,
          createdAt: new Date(),
          retryCount: 0,
          maxRetries: 1,
          taskType: "summary",
        },
      ],
    ]);
    manager.processingTasks = new Set();
    manager.taskAbortControllers = new Map();
    manager.abortingTasks = new Set();
    manager.progressCallbacks = new Set();
    manager.completeCallbacks = new Set();
    manager.streamCallbacks = new Set();
    manager.deletedFixedTasks = new Map();
    manager.clearedDeletedFixedTaskKeys = new Set();
    manager.saveToStorage = async () => undefined;
    manager.isRunning = true;
    try {
      const quickFail = await manager.executeTask("summary-task-1");
      const task = manager.tasks.get("summary-task-1");
      expect(quickFail).to.equal(false);
      expect(task.status).to.equal(TaskStatus.COMPLETED);
      expect(gateCalled).to.equal(true);
      expect(lunaOptions.metadata).to.include({
        role: "luna",
        itemKey: "ITEM-QUEUE",
      });
      expect(turns).to.deep.equal(["sol", "sol"]);
      expect(
        (await ledger.findLatest({ itemKey: "ITEM-QUEUE" }))?.status,
      ).to.equal("passed");
      expect(fileSystem.content).not.to.contain("Queue paper");
    } finally {
      ProviderRegistry.register(originalProvider!);
      ContentExtractor.hasAnalyzableAttachment = originalHasAnalyzable;
      TaskArtifacts.probe = originalProbe;
      TaskArtifacts.probeCandidate = originalProbeCandidate;
      NoteGenerator.generateNoteForItem = originalGenerateNote;
      LLMService.setCodexTaskLedger(null);
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("writes the final note only after a contract, Luna result, and artifact probe pass", async function () {
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ledger.jsonl", {
      fileSystem,
      idFactory: (() => {
        let index = 0;
        return () => `exec-${++index}`;
      })(),
    });
    let writeCount = 0;

    const result = await runCodexTaskGate(
      gateOptions(ledger, {
        writeFinalNote: async () => {
          writeCount += 1;
        },
      }),
    );

    expect(result.status).to.equal("passed");
    expect(result.acceptance).to.equal("PASS");
    expect(writeCount).to.equal(1);
    expect((await ledger.query({ status: "passed" })).length).to.be.greaterThan(
      0,
    );
  });

  it("blocks final-note writing when the generated artifact probe fails", async function () {
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ledger.jsonl", {
      fileSystem,
      idFactory: () => "exec-probe-failure",
    });
    let writeCount = 0;

    const result = await runCodexTaskGate(
      gateOptions(ledger, {
        probeArtifact: async () => ({
          exists: false,
          probeFailed: true,
          reason: "probe-failed",
        }),
        writeFinalNote: async () => {
          writeCount += 1;
        },
      }),
    );

    expect(result.status).to.equal("blocked");
    expect(result.acceptance).to.equal("BLOCKED");
    expect(writeCount).to.equal(0);
    expect(
      (await ledger.query({ status: "blocked" })).length,
    ).to.be.greaterThan(0);
  });

  it("does not run Luna when the Sol contract is absent", async function () {
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ledger.jsonl", {
      fileSystem,
      idFactory: () => "exec-no-contract",
    });
    let lunaRunCount = 0;
    let writeCount = 0;

    const result = await runCodexTaskGate(
      gateOptions(ledger, {
        contract: undefined,
        runLuna: async () => {
          lunaRunCount += 1;
          return { executionId: "unexpected", outputSummary: "unexpected" };
        },
        writeFinalNote: async () => {
          writeCount += 1;
        },
      }),
    );

    expect(result.status).to.equal("blocked");
    expect(result.acceptance).to.equal("BLOCKED");
    expect(lunaRunCount).to.equal(0);
    expect(writeCount).to.equal(0);
  });

  it("marks image-summary as unsupported for Codex without invoking a provider", function () {
    expect(
      isCodexImageSummaryUnsupported({ providerType: "codex-app-server" }),
    ).to.equal(true);
    expect(isCodexImageSummaryUnsupported({ providerType: "openai" })).to.equal(
      false,
    );
  });

  it("cleans up registered Codex processes on shutdown", function () {
    let killCount = 0;
    const process = new CodexAppServerProcess({
      stdin: { write: () => undefined },
      kill: () => {
        killCount += 1;
      },
    });

    CodexAppServerProcess.cleanup();

    expect(killCount).to.equal(1);
    expect(process.getDiagnostics()).to.equal("");
  });
});
