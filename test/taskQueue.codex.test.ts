import { expect } from "chai";
import {
  TaskQueueManager,
  TaskStatus,
  isCodexImageSummaryUnsupported,
  parseCodexSolAcceptance,
  parseCodexSolContract,
} from "../src/modules/taskQueue";
import {
  CodexTaskLedger,
  type CodexTaskLedgerFileSystem,
} from "../src/modules/codexTaskLedger";
import LLMService from "../src/modules/llmService";
import { LLMEndpointManager } from "../src/modules/llmEndpointManager";
import { ProviderRegistry } from "../src/modules/llmproviders/ProviderRegistry";
import { CodexAppServerProcess } from "../src/modules/llmproviders/codexAppServer/CodexAppServerProcess";
import { ContentExtractor } from "../src/modules/contentExtractor";
import { NoteGenerator } from "../src/modules/noteGenerator";
import { TaskArtifacts } from "../src/modules/taskArtifacts";
import { AiNoteService } from "../src/modules/aiNoteService";
import { PDFExtractor } from "../src/modules/pdfExtractor";
import { TaskQueueView } from "../src/modules/views/TaskQueueView";

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

function createResumeTemplate(): Record<string, unknown> {
  return {
    id: "resume-test",
    name: "Resume test",
    description: "",
    version: 2,
    prompts: [],
    phases: [
      {
        id: "seq",
        title: "Sequential",
        type: "sequential_dynamic",
        description: "",
        contextStrategy: "last_round",
        planningPrompt: "Return chapters as JSON.",
        fixedPrompts: [
          {
            id: "slot-1",
            order: 1,
            title: "Method",
            prompt: "Read the method.",
          },
        ],
        chapterTemplate: "Read {{title_en}}.",
        maxChapters: 1,
      },
    ],
  };
}

function createLegacyResumeHtml(): string {
  return "<h1>AI Deep Read - Paper</h1><p>Chapter 1: Method</p><h2>Method</h2><p>legacy answer</p><p>⏳ 等待生成...</p>";
}

describe("Codex task queue gate", function () {
  it("fails closed for malformed, negated, or non-strict Sol acceptance", function () {
    const rejected = [
      "not pass",
      "BYPASS",
      "PASS because the candidate is incomplete",
      JSON.stringify({ acceptance: "PARTIAL_PASS" }),
      JSON.stringify({ acceptance: "PASS " }),
      JSON.stringify({ status: "PASS" }),
      "",
    ];
    for (const response of rejected) {
      expect(parseCodexSolAcceptance(response), response).to.equal("BLOCKED");
    }
    expect(
      parseCodexSolAcceptance(JSON.stringify({ acceptance: "PASS" })),
    ).to.equal("PASS");
    expect(
      parseCodexSolAcceptance(JSON.stringify({ acceptance: "PARTIAL" })),
    ).to.equal("PARTIAL");
    expect(
      parseCodexSolAcceptance(JSON.stringify({ acceptance: "BLOCKED" })),
    ).to.equal("BLOCKED");
  });

  it("requires a structured task spec in the Sol contract", function () {
    const parsed = parseCodexSolContract(
      JSON.stringify({
        taskType: "summary",
        outputSchema: { format: "markdown", required: ["problem", "method"] },
        inputBoundaries: ["only the selected Zotero attachment"],
        acceptanceDimensions: ["criterion evidence is present"],
        acceptanceCriteria: ["candidate probe passes"],
        outputSummary: "one bounded summary candidate",
      }),
      "sol-plan-contract",
      "Zotero item ITEM-1",
    );

    expect(parsed).to.include({
      executionId: "sol-plan-contract",
      taskType: "summary",
    });
    expect(parsed?.outputSchema).to.deep.include({ format: "markdown" });
    expect(parsed?.inputBoundaries).to.deep.equal([
      "only the selected Zotero attachment",
    ]);
    expect(parsed?.acceptanceDimensions).to.deep.equal([
      "criterion evidence is present",
    ]);
  });

  it("fails closed when a summary candidate is missing the required sections", async function () {
    const item = { id: 1 } as unknown as Zotero.Item;
    const missingEvidence = await TaskArtifacts.probeCandidate(
      "summary",
      item,
      "<h2>Summary</h2><p>candidate</p>",
      "## Summary\n\nCandidate claim",
    );
    expect(missingEvidence).to.deep.include({
      exists: false,
      reason: "candidate-summary-sections-missing",
    });

    const complete = await TaskArtifacts.probeCandidate(
      "summary",
      item,
      "<h2>Summary</h2><p>candidate</p><h2>Evidence</h2><p>source</p>",
      "## Summary\n\nCandidate claim\n\n## Evidence\n\n- Source evidence",
    );
    expect(complete).to.deep.include({
      exists: true,
      reason: "candidate-ready",
    });
  });

  it("does not mutate a Codex deep-read resume note before Sol acceptance", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const previousChat = LLMService.chat;
    const previousSave = AiNoteService.saveGeneratedNote;
    const prefs = new Map<string, unknown>([
      ["extensions.zotero.aiButler.multiRoundPromptTemplateId", "resume-test"],
      [
        "extensions.zotero.aiButler.multiRoundPromptTemplates",
        JSON.stringify([createResumeTemplate()]),
      ],
    ]);
    const formatMessagesSync = (requests: Array<{ id: string }>) =>
      requests.map(({ id }) => ({ value: id, attributes: [] }));
    globalValue.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
        clear: (key: string) => prefs.delete(key),
      },
    };
    globalValue.addon = {
      data: { locale: { current: { formatMessagesSync } } },
    };
    globalValue.ztoolkit = { log: () => undefined };

    const sourceItem = {
      id: 1,
      key: "ITEM-RESUME",
      libraryID: 1,
      getField: () => "Paper",
    } as unknown as Zotero.Item;
    const originalHtml = createLegacyResumeHtml();
    let currentHtml = originalHtml;
    let setNoteCount = 0;
    let saveTxCount = 0;
    const existingNote = {
      id: 20,
      parentID: 1,
      getNote: () => currentHtml,
      setNote: (value: string) => {
        setNoteCount += 1;
        currentHtml = value;
      },
      saveTx: async () => {
        saveTxCount += 1;
      },
    } as unknown as Zotero.Item;
    const deepReadResponse = {
      text: "fresh method answer",
      providerId: "codex-app-server",
      executionId: "luna-exec",
      role: "luna" as const,
      status: "passed" as const,
      model: "gpt-5.6-luna",
    };
    LLMService.chat = (async () => deepReadResponse) as any;
    let saveGeneratedCount = 0;
    AiNoteService.saveGeneratedNote = (async (options: any) => {
      saveGeneratedCount += 1;
      expect(options.existing).to.equal(existingNote);
      options.existing.setNote(options.html);
      await options.existing.saveTx();
      return options.existing;
    }) as any;

    try {
      let gateCalled = 0;
      let rejected = false;
      try {
        await (NoteGenerator as any).generateDeepReadContent({
          item: sourceItem,
          existing: existingNote,
          existingHtml: originalHtml,
          policy: "overwrite",
          pdfContent: "safe text",
          isBase64: false,
          itemTitle: "Paper",
          noteWriteGate: async () => {
            gateCalled += 1;
            return false;
          },
        });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
      expect(gateCalled).to.equal(1);
      expect(saveGeneratedCount).to.equal(0);
      expect(setNoteCount).to.equal(0);
      expect(saveTxCount).to.equal(0);
      expect(currentHtml).to.equal(originalHtml);
    } finally {
      LLMService.chat = previousChat;
      AiNoteService.saveGeneratedNote = previousSave;
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("commits a Codex deep-read resume exactly once after Sol acceptance", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const previousChat = LLMService.chat;
    const previousSave = AiNoteService.saveGeneratedNote;
    const prefs = new Map<string, unknown>([
      ["extensions.zotero.aiButler.multiRoundPromptTemplateId", "resume-test"],
      [
        "extensions.zotero.aiButler.multiRoundPromptTemplates",
        JSON.stringify([createResumeTemplate()]),
      ],
    ]);
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
    const sourceItem = {
      id: 1,
      key: "ITEM-RESUME",
      libraryID: 1,
      getField: () => "Paper",
    } as unknown as Zotero.Item;
    const originalHtml = createLegacyResumeHtml();
    let currentHtml = originalHtml;
    let setNoteCount = 0;
    let saveTxCount = 0;
    const existingNote = {
      id: 20,
      parentID: 1,
      getNote: () => currentHtml,
      setNote: (value: string) => {
        setNoteCount += 1;
        currentHtml = value;
      },
      saveTx: async () => {
        saveTxCount += 1;
      },
    } as unknown as Zotero.Item;
    LLMService.chat = (async () => ({
      text: "fresh method answer",
      providerId: "codex-app-server",
      executionId: "luna-exec",
      role: "luna" as const,
      status: "passed" as const,
      model: "gpt-5.6-luna",
    })) as any;
    let saveGeneratedCount = 0;
    AiNoteService.saveGeneratedNote = (async (options: any) => {
      saveGeneratedCount += 1;
      expect(options.existing).to.equal(existingNote);
      options.existing.setNote(options.html);
      await options.existing.saveTx();
      return options.existing;
    }) as any;

    try {
      let gateCalled = 0;
      const result = await (NoteGenerator as any).generateDeepReadContent({
        item: sourceItem,
        existing: existingNote,
        existingHtml: originalHtml,
        policy: "overwrite",
        pdfContent: "safe text",
        isBase64: false,
        itemTitle: "Paper",
        noteWriteGate: async (candidate: any) => {
          gateCalled += 1;
          expect(candidate.html).to.contain("fresh method answer");
          return true;
        },
      });
      expect(result.note).to.equal(existingNote);
      expect(gateCalled).to.equal(1);
      expect(saveGeneratedCount).to.equal(1);
      expect(setNoteCount).to.equal(1);
      expect(saveTxCount).to.equal(1);
    } finally {
      LLMService.chat = previousChat;
      AiNoteService.saveGeneratedNote = previousSave;
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("stops during content extraction before any LLM call or note write", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const previousFind = AiNoteService.findNoteRecord;
    const previousExtract = ContentExtractor.extractAnalyzableContentFromItem;
    const previousGenerate = LLMService.generate;
    const previousSave = AiNoteService.saveGeneratedNote;
    const previousMode = LLMService.getEffectivePdfProcessMode;
    const prefs = new Map<string, unknown>([
      ["extensions.zotero.aiButler.noteStrategy", "overwrite"],
      ["extensions.zotero.aiButler.summaryMode", "deepRead"],
      ["extensions.zotero.aiButler.pdfProcessMode", "text"],
      ["extensions.zotero.aiButler.enablePdfSizeLimit", false],
    ]);
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
    const item = {
      id: 10,
      key: "ITEM-ABORT",
      getField: () => "Abort paper",
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    const abortController = new AbortController();
    let extractCount = 0;
    let llmCount = 0;
    let saveCount = 0;
    AiNoteService.findNoteRecord = async () => null;
    ContentExtractor.extractAnalyzableContentFromItem = async () => {
      extractCount += 1;
      abortController.abort("cancelled during extraction");
      return {
        content: "should not reach the model",
        isBase64: false,
        kind: "pdf",
      };
    };
    LLMService.getEffectivePdfProcessMode = (() => "text") as any;
    LLMService.generate = (async () => {
      llmCount += 1;
      return { text: "unexpected" };
    }) as any;
    AiNoteService.saveGeneratedNote = (async () => {
      saveCount += 1;
      return item;
    }) as any;
    try {
      let thrown: unknown;
      try {
        await NoteGenerator.generateNoteForItem(
          item,
          undefined,
          undefined,
          undefined,
          { abortSignal: abortController.signal },
        );
      } catch (error) {
        thrown = error;
      }
      expect(extractCount).to.equal(1);
      expect(llmCount).to.equal(0);
      expect(saveCount).to.equal(0);
      expect(thrown).to.be.instanceOf(Error);
    } finally {
      AiNoteService.findNoteRecord = previousFind;
      ContentExtractor.extractAnalyzableContentFromItem = previousExtract;
      LLMService.generate = previousGenerate;
      AiNoteService.saveGeneratedNote = previousSave;
      LLMService.getEffectivePdfProcessMode = previousMode;
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

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
      generateSummary: async (_content, isBase64, prompt, options) => {
        seen.push({ isBase64, prompt, options });
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
          codexContract: {
            taskType: "summary",
            outputSchema: { format: "markdown", required: ["summary"] },
            inputBoundaries: ["selected item only"],
            acceptanceDimensions: ["evidence"],
          },
        },
      });

      expect(seen).to.have.length(1);
      expect(seen[0].isBase64).to.equal(false);
      expect(seen[0].prompt).to.contain("Codex contract");
      expect(seen[0].options.codexContract).to.deep.include({
        taskType: "summary",
      });
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

  it("serializes two priority-style Codex summary calls through one turn slot", async function () {
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
    const ledger = new CodexTaskLedger("/tmp/ledger.jsonl", {
      fileSystem: new MemoryLedgerFileSystem(),
    });
    let active = 0;
    let maxActive = 0;
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
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 8));
        active -= 1;
        return "summary";
      },
      chat: async () => "chat",
      testConnection: async () => "OK",
    } as any);
    LLMEndpointManager.saveEndpoints([
      LLMEndpointManager.createEndpoint("codex-app-server", "sol"),
    ]);
    LLMService.setCodexTaskLedger(ledger);
    try {
      await Promise.all(
        ["priority-a", "priority-b"].map((itemKey) =>
          LLMService.generate({
            task: "summary",
            content: { kind: "text", text: itemKey },
            transport: { retry: false },
            metadata: { role: "luna", itemKey },
          }),
        ),
      );
      expect(maxActive).to.equal(1);
    } finally {
      if (originalProvider) ProviderRegistry.register(originalProvider);
      LLMService.setCodexTaskLedger(null);
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("creates a new provider execution id for each retry attempt", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const previousProvider = ProviderRegistry.get("codex-app-server");
    const prefs = new Map<string, unknown>([["maxApiSwitchCount", "2"]]);
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
    const ledger = new CodexTaskLedger("/tmp/ledger-retry.jsonl", {
      fileSystem,
    });
    const executionIds: string[] = [];
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
      generateSummary: async (_content, _isBase64, _prompt, options) => {
        providerCallCount += 1;
        executionIds.push(options.executionId || "missing");
        if (providerCallCount === 1)
          throw new Error("transient provider error");
        return "retry succeeded";
      },
      chat: async () => "chat",
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
        content: { kind: "text", text: "safe retry input" },
        metadata: { role: "sol", itemKey: "ITEM-RETRY" },
        transport: { retry: true },
      });
      expect(response.text).to.equal("retry succeeded");
      expect(providerCallCount).to.equal(2);
      expect(executionIds[0]).not.to.equal(executionIds[1]);
      expect(
        (await ledger.query({ itemKey: "ITEM-RETRY" })).map(
          (record) => record.status,
        ),
      ).to.include.members(["failed", "passed"]);
    } finally {
      if (previousProvider) ProviderRegistry.register(previousProvider);
      LLMService.setCodexTaskLedger(null);
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("serializes Codex calls from a parallelizable deep-read phase", async function () {
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
    const ledger = new CodexTaskLedger("/tmp/ledger.jsonl", {
      fileSystem: new MemoryLedgerFileSystem(),
    });
    let active = 0;
    let maxActive = 0;
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
      generateSummary: async () => "summary",
      chat: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 8));
        active -= 1;
        return "chapter";
      },
      testConnection: async () => "OK",
    } as any);
    LLMEndpointManager.saveEndpoints([
      LLMEndpointManager.createEndpoint("codex-app-server", "luna"),
    ]);
    LLMService.setCodexTaskLedger(ledger);
    try {
      await Promise.all(
        ["chapter-a", "chapter-b"].map((title) =>
          LLMService.chat({
            content: { kind: "text", text: "safe paper text" },
            conversation: [{ role: "user", content: `Read ${title}` }],
            transport: { retry: false },
            metadata: { role: "luna", itemKey: "ITEM-DEEP" },
          }),
        ),
      );
      expect(maxActive).to.equal(1);
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
    const originalLedgerGetter = LLMService.getCodexTaskLedger;
    let ledgerInitCount = 0;
    LLMService.getCodexTaskLedger = (() => {
      ledgerInitCount += 1;
      throw new Error(
        "ledger initialization must not precede input validation",
      );
    }) as any;
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
      expect(ledgerInitCount).to.equal(0);
    } finally {
      if (originalProvider) ProviderRegistry.register(originalProvider);
      LLMService.getCodexTaskLedger = originalLedgerGetter;
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("rejects every structured pdf-files Base64 field before ledger or Provider side effects", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const previousProvider = ProviderRegistry.get("codex-app-server");
    const previousLedgerGetter = LLMService.getCodexTaskLedger;
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
    let ledgerInitCount = 0;
    let providerCallCount = 0;
    LLMService.getCodexTaskLedger = (() => {
      ledgerInitCount += 1;
      throw new Error(
        "ledger initialization must not precede input validation",
      );
    }) as any;
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
      chat: async () => {
        providerCallCount += 1;
        return "unexpected";
      },
      testConnection: async () => "OK",
    } as any);
    LLMEndpointManager.saveEndpoints([
      LLMEndpointManager.createEndpoint("codex-app-server", "sol"),
    ]);
    const baseFile = {
      filePath: "/safe/document.pdf",
      displayName: "document.pdf",
      base64Content: "JVBERi0xLjQKprivate",
    };
    try {
      for (const task of ["summary", "chat"] as const) {
        for (const policy of [undefined, "text"] as const) {
          for (const textContent of [
            undefined,
            "safe extracted text",
          ] as const) {
            const content = {
              kind: "pdf-files" as const,
              files: [{ ...baseFile, textContent }],
              ...(policy ? { policy } : {}),
            };
            let thrown: Error | undefined;
            try {
              if (task === "summary") {
                await LLMService.generate({
                  task,
                  content,
                  transport: { retry: false },
                });
              } else {
                await LLMService.chat({
                  content,
                  conversation: [{ role: "user", content: "Read" }],
                  transport: { retry: false },
                });
              }
            } catch (error) {
              thrown =
                error instanceof Error ? error : new Error(String(error));
            }
            expect(
              thrown?.message,
              `${task}/${policy || "implicit"}/${textContent ? "with-text" : "base64-only"}`,
            ).to.match(/endpoint-pdf-unsupported|unsupported/i);
          }
        }
      }
      expect(ledgerInitCount).to.equal(0);
      expect(providerCallCount).to.equal(0);
    } finally {
      LLMService.getCodexTaskLedger = previousLedgerGetter;
      if (previousProvider) ProviderRegistry.register(previousProvider);
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
                taskType: "summary",
                outputSchema: {
                  format: "markdown",
                  required: ["summary"],
                },
                inputBoundaries: ["selected Zotero item only"],
                acceptanceDimensions: ["candidate evidence"],
                acceptanceCriteria: ["candidate and probe are valid"],
                outputSummary: "a bounded summary candidate",
              })
            : JSON.stringify({
                acceptance: "PASS",
                criteria: [
                  {
                    criterion: "candidate and probe are valid",
                    verdict: "PASS",
                    evidence: "bounded candidate probe is true",
                  },
                ],
              }),
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
      const longCandidate =
        "## Summary\n\n" +
        "Synthetic bounded summary claim.\n\n".repeat(180) +
        "## Evidence\n\n- Synthetic evidence supports the summary claim.\n";
      const acceptance = await manager.runCodexSolAcceptance(
        execution,
        {
          html: "<h2>Summary</h2><p>ready</p><h2>Evidence</h2><p>evidence</p>",
          content: longCandidate,
        },
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
      expect(calls[1].content.text).to.contain("candidateExcerpt");
      expect(calls[1].content.text).to.contain("criterionEvidence");
      expect(calls[1].content.text).to.contain("candidateDigest");
      const acceptanceInput = JSON.parse(calls[1].content.text);
      expect(acceptanceInput.candidate.candidateExcerpt).to.contain(
        "## Evidence",
      );
      expect(
        acceptanceInput.runtimeEvidence.noZoteroWritesBeforeAcceptance,
      ).to.equal(true);
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
                taskType: "summary",
                outputSchema: {
                  format: "markdown",
                  required: ["problem", "method"],
                },
                inputBoundaries: ["only the selected Zotero attachment"],
                acceptanceDimensions: ["criterion evidence is present"],
                acceptanceCriteria: ["candidate probe passes"],
                outputSummary: "queue candidate",
              })
            : JSON.stringify({
                acceptance: "PASS",
                criteria: [
                  {
                    criterion: "candidate probe passes",
                    verdict: "PASS",
                    evidence: "candidate probe exists",
                  },
                ],
              });
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
        reasoningEffort: "high",
        itemKey: "ITEM-QUEUE",
      });
      expect(lunaOptions.metadata.codexContract).to.include({
        taskType: "summary",
      });
      expect(turns).to.deep.equal(["sol", "sol"]);
      const lunaRecord = (await ledger.readAll()).find(
        (record) => record.role === "luna",
      );
      expect(lunaRecord?.reasoningEffort).to.equal("high");
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

  it("runs the production queue through Sol, real NoteGenerator/Luna, and Sol acceptance", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const previousProvider = ProviderRegistry.get("codex-app-server");
    const previousHasAnalyzable = ContentExtractor.hasAnalyzableAttachment;
    const previousAttachments = PDFExtractor.getAllPdfAttachments;
    const previousExtractText = PDFExtractor.extractTextFromItem;
    const previousFindNoteRecord = AiNoteService.findNoteRecord;
    const previousSaveGeneratedNote = AiNoteService.saveGeneratedNote;
    const previousProbeCandidate = TaskArtifacts.probeCandidate;
    const previousProbe = TaskArtifacts.probe;
    const prefs = new Map<string, unknown>([
      ["extensions.zotero.aiButler.noteStrategy", "overwrite"],
      ["extensions.zotero.aiButler.summaryMode", "single"],
      ["extensions.zotero.aiButler.pdfProcessMode", "text"],
      ["extensions.zotero.aiButler.pdfAttachmentMode", "default"],
      ["extensions.zotero.aiButler.enablePdfSizeLimit", false],
      ["extensions.zotero.aiButler.enableTableOnSingleNote", false],
    ]);
    const item = {
      id: 22,
      key: "ITEM-PRODUCTION",
      libraryID: 1,
      getField: () => "Production paper",
      getAttachments: () => [220],
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    const attachment = {
      id: 220,
      key: "ATTACH-PRODUCTION",
      attachmentContentType: "application/pdf",
      getFilePathAsync: async () => undefined,
    } as unknown as Zotero.Item;
    globalValue.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
        clear: (key: string) => prefs.delete(key),
      },
      Items: {
        getAsync: async (id: number) => (id === 22 ? item : attachment),
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
    const ledger = new CodexTaskLedger("/tmp/ledger-production.jsonl", {
      fileSystem,
    });
    const roles: string[] = [];
    const reasoningEfforts: string[] = [];
    const providerExecutionIds: string[] = [];
    const eventLog: string[] = [];
    let saveTxCount = 0;
    let persistedProbeCount = 0;
    let providerCall = 0;
    let acceptanceValue: "PASS" | "BLOCKED" = "PASS";
    let acceptanceProviderReturned = false;
    let deferAcceptance = true;
    let releaseAcceptance!: () => void;
    const acceptanceRelease = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let signalAcceptanceStarted!: () => void;
    const acceptanceStarted = new Promise<void>((resolve) => {
      signalAcceptanceStarted = resolve;
    });
    const note = {
      id: 221,
      parentID: item.id,
      getNote: () => "<h2>AI Summary</h2><p>Luna candidate</p>",
      setNote: () => undefined,
      saveTx: async () => {
        saveTxCount += 1;
      },
    } as unknown as Zotero.Item;
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
      generateSummary: async (_content, isBase64, prompt, options) => {
        expect(isBase64).to.equal(false);
        roles.push(options.role || "unknown");
        reasoningEfforts.push(String(options.reasoningEffort || ""));
        if (options.role === "luna") {
          expect(prompt).to.contain("## Summary");
          expect(prompt).to.contain("## Evidence");
        }
        providerCall += 1;
        const text =
          providerCall === 1
            ? JSON.stringify({
                taskType: "summary",
                outputSchema: { format: "markdown", required: ["summary"] },
                inputBoundaries: ["selected item and attachment only"],
                acceptanceDimensions: ["candidate evidence"],
                acceptanceCriteria: ["candidate probe passes"],
                outputSummary: "bounded candidate",
              })
            : providerCall === 2
              ? "Luna candidate"
              : JSON.stringify({
                  acceptance: acceptanceValue,
                  criteria: [
                    {
                      criterion: "candidate probe passes",
                      verdict: "PASS",
                      evidence: "candidate probe and persisted probe passed",
                    },
                  ],
                });
        if (providerCall === 1) eventLog.push("planning:done");
        if (providerCall === 2) eventLog.push("luna:done");
        if (providerCall === 3) {
          acceptanceProviderReturned = false;
          eventLog.push("acceptance:start");
          signalAcceptanceStarted();
          if (deferAcceptance) await acceptanceRelease;
        }
        expect(prompt).to.be.a("string");
        await options.onCodexTurnResult?.({
          threadId: `production-thread-${providerCall}`,
          turnId: `production-turn-${providerCall}`,
          text,
          diagnostics: [{ method: "turn/completed", status: "completed" }],
          events: [{ method: "turn/completed", status: "completed" }],
        });
        providerExecutionIds.push(options.executionId || "missing");
        if (providerCall === 3) {
          eventLog.push(`acceptance:done:${acceptanceValue}`);
          acceptanceProviderReturned = true;
        }
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
    PDFExtractor.getAllPdfAttachments = async () => [attachment];
    PDFExtractor.extractTextFromItem = async () => "safe extracted text";
    AiNoteService.findNoteRecord = async () => null;
    AiNoteService.saveGeneratedNote = async (options: any) => {
      expect(eventLog.at(-1)).to.equal("acceptance:done:PASS");
      expect(acceptanceProviderReturned).to.equal(true);
      eventLog.push("save");
      const html = options.html as string;
      saveTxCount += 1;
      (note as any).getNote = () => html;
      return note;
    };
    TaskArtifacts.probeCandidate = async () => ({
      exists: true,
      reason: "candidate-ready",
    });
    TaskArtifacts.probe = async () => {
      expect(eventLog.at(-1)).to.equal("save");
      eventLog.push("persisted-probe");
      persistedProbeCount += 1;
      expect(saveTxCount).to.be.greaterThan(0);
      return { exists: true, reason: "persisted" };
    };
    const manager = Object.create(TaskQueueManager.prototype) as any;
    manager.tasks = new Map([
      [
        "summary-task-production",
        {
          id: "summary-task-production",
          itemId: item.id,
          title: "Production paper",
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
    manager.completeCallbacks.add((_taskId: string, success: boolean) => {
      if (success) {
        expect(eventLog.at(-1)).to.equal("persisted-probe");
        eventLog.push("complete");
      }
    });
    manager.streamCallbacks = new Set();
    manager.deletedFixedTasks = new Map();
    manager.clearedDeletedFixedTaskKeys = new Set();
    manager.saveToStorage = async () => undefined;
    manager.isRunning = true;
    try {
      const taskExecution = manager.executeTask("summary-task-production");
      await acceptanceStarted;
      expect(saveTxCount).to.equal(0);
      expect(persistedProbeCount).to.equal(0);
      expect(eventLog).to.deep.equal([
        "planning:done",
        "luna:done",
        "acceptance:start",
      ]);
      releaseAcceptance();
      const quickFail = await taskExecution;
      const task = manager.tasks.get("summary-task-production");
      expect(quickFail).to.equal(false);
      expect(task.status).to.equal(TaskStatus.COMPLETED);
      expect(task.codexDecision).to.equal("PASS");
      expect(roles.slice(0, 3)).to.deep.equal(["sol", "luna", "sol"]);
      expect(reasoningEfforts.slice(0, 3)).to.deep.equal([
        "high",
        "high",
        "high",
      ]);
      expect(providerExecutionIds).to.have.length(3);
      expect(new Set(providerExecutionIds).size).to.equal(3);
      expect(saveTxCount).to.equal(1);
      expect(persistedProbeCount).to.equal(1);
      expect(eventLog).to.deep.equal([
        "planning:done",
        "luna:done",
        "acceptance:start",
        "acceptance:done:PASS",
        "save",
        "persisted-probe",
        "complete",
      ]);

      acceptanceValue = "BLOCKED";
      deferAcceptance = false;
      providerCall = 0;
      saveTxCount = 0;
      persistedProbeCount = 0;
      eventLog.length = 0;
      manager.tasks.set("summary-task-production", {
        id: "summary-task-production",
        itemId: item.id,
        title: "Production paper",
        status: TaskStatus.PENDING,
        progress: 0,
        createdAt: new Date(),
        retryCount: 0,
        maxRetries: 1,
        taskType: "summary",
      });
      await manager.executeTask("summary-task-production");
      const blockedTask = manager.tasks.get("summary-task-production");
      expect(blockedTask.status).to.equal(TaskStatus.FAILED);
      expect(blockedTask.codexDecision).to.equal("BLOCKED");
      expect(blockedTask.failureCode).to.equal("codex-sol-acceptance-blocked");
      expect(blockedTask.error).to.contain("Codex 验收未通过");
      expect(blockedTask.error).not.to.equal("未知错误");
      expect(blockedTask.errorDetails).to.contain("criteriaPass=1");
      expect(blockedTask.retryCount).to.equal(0);
      expect(saveTxCount).to.equal(0);
      expect(persistedProbeCount).to.equal(0);
      expect(eventLog).to.deep.equal([
        "planning:done",
        "luna:done",
        "acceptance:start",
        "acceptance:done:BLOCKED",
      ]);
      expect(roles.slice(3)).to.deep.equal(["sol", "luna", "sol"]);
      expect(reasoningEfforts.slice(3)).to.deep.equal(["high", "high", "high"]);
      const records = await ledger.readAll();
      const aggregateRecords = records.filter(
        (record) => record.itemKey === item.key,
      );
      expect(
        aggregateRecords.some((record) => record.status === "passed"),
      ).to.equal(true);
      expect(
        aggregateRecords.some(
          (record) => record.providerExecutionIds?.length === 1,
        ),
      ).to.equal(true);
    } finally {
      if (previousProvider) ProviderRegistry.register(previousProvider);
      ContentExtractor.hasAnalyzableAttachment = previousHasAnalyzable;
      PDFExtractor.getAllPdfAttachments = previousAttachments;
      PDFExtractor.extractTextFromItem = previousExtractText;
      AiNoteService.findNoteRecord = previousFindNoteRecord;
      AiNoteService.saveGeneratedNote = previousSaveGeneratedNote;
      TaskArtifacts.probeCandidate = previousProbeCandidate;
      TaskArtifacts.probe = previousProbe;
      LLMService.setCodexTaskLedger(null);
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("fails closed when the current attachment bytes mismatch the expected hash", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const previousIo = globalValue.IOUtils;
    const previousAttachments = PDFExtractor.getAllPdfAttachments;
    const previousGenerate = LLMService.generate;
    const prefs = new Map<string, unknown>();
    const attachment = {
      key: "ATTACH-HASH",
      getFilePathAsync: async () => "/safe/attachment.pdf",
    } as unknown as Zotero.Item;
    const item = { id: 1, key: "ITEM-HASH" } as unknown as Zotero.Item;
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
    globalValue.IOUtils = {
      read: async () => new TextEncoder().encode("current attachment bytes"),
    };
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ledger-hash.jsonl", {
      fileSystem,
    });
    LLMService.setCodexTaskLedger(ledger);
    let providerCallCount = 0;
    LLMService.generate = (async () => {
      providerCallCount += 1;
      throw new Error("planner must not run after a hash mismatch");
    }) as any;
    PDFExtractor.getAllPdfAttachments = async () => [attachment];
    try {
      const manager = Object.create(TaskQueueManager.prototype) as any;
      let thrown: any;
      try {
        await manager.createCodexQueueExecution(
          {
            id: "hash-task",
            itemId: 1,
            title: "Hash paper",
            status: TaskStatus.PENDING,
            progress: 0,
            createdAt: new Date(),
            retryCount: 0,
            maxRetries: 1,
            options: {
              itemKey: "ITEM-HASH",
              attachmentKey: "ATTACH-HASH",
              sourceSha256: "0".repeat(64),
            },
          },
          item,
          LLMEndpointManager.createEndpoint("codex-app-server", "sol"),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.code).to.equal("codex-source-sha256-mismatch");
      expect(providerCallCount).to.equal(0);
      const record = await ledger.findLatest({ itemKey: "ITEM-HASH" });
      expect(record?.status).to.equal("failed");
      expect(record?.sourceSha256Verified).to.equal(false);
      expect(record?.sourceSha256Mismatch).to.equal(true);
      expect(record?.sourceSha256).not.to.equal("0".repeat(64));
    } finally {
      LLMService.generate = previousGenerate;
      LLMService.setCodexTaskLedger(null);
      PDFExtractor.getAllPdfAttachments = previousAttachments;
      globalValue.IOUtils = previousIo;
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
  });

  it("persists Codex decisions without retrying and exposes them in queue error copy", function () {
    const globalValue = globalThis as any;
    const previousAddon = globalValue.addon;
    const previousZotero = globalValue.Zotero;
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
    globalValue.Zotero = {
      version: "test",
      getMainWindow: () => ({ navigator: {} }),
    };
    try {
      const view = Object.create(TaskQueueView.prototype) as any;
      const task = {
        id: "blocked-task",
        itemId: 1,
        title: "Blocked paper",
        status: TaskStatus.FAILED,
        progress: 40,
        createdAt: new Date("2026-08-28T00:00:00Z"),
        retryCount: 0,
        maxRetries: 2,
        codexDecision: "BLOCKED",
        failureCode: "codex-source-sha256-mismatch",
        error: "hash mismatch",
      };
      const label = view.getCodexDecisionLabel(task);
      const copy = view.buildTaskErrorCopyText(task);
      const manager = Object.create(TaskQueueManager.prototype) as any;
      const managerCopy = manager.buildTaskErrorDetails(
        task,
        new Error("failed"),
      );
      expect(label).to.contain("task-queue-codex-decision-blocked");
      expect(copy).to.contain("codexDecision: BLOCKED");
      expect(copy).to.contain("failureCode: codex-source-sha256-mismatch");
      expect(managerCopy).to.contain("codexDecision: BLOCKED");
      expect(managerCopy).to.contain(
        "failureCode: codex-source-sha256-mismatch",
      );
      expect(task.retryCount).to.equal(0);
    } finally {
      globalValue.addon = previousAddon;
      globalValue.Zotero = previousZotero;
    }
  });

  it("round-trips PARTIAL/BLOCKED Codex decisions and hash errors through queue storage", async function () {
    const globalValue = globalThis as any;
    const previousZotero = globalValue.Zotero;
    const previousAddon = globalValue.addon;
    const previousToolkit = globalValue.ztoolkit;
    const stored = new Map<string, string>();
    globalValue.Zotero = {
      Prefs: {
        get: (key: string) => stored.get(key),
        set: (key: string, value: string) => stored.set(key, value),
        clear: (key: string) => stored.delete(key),
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
    const partialTask = {
      id: "partial-task",
      itemId: 1,
      title: "Partial paper",
      status: TaskStatus.FAILED,
      progress: 50,
      createdAt: new Date("2026-08-28T00:00:00Z"),
      retryCount: 0,
      maxRetries: 2,
      codexDecision: "PARTIAL",
      failureCode: "codex-sol-acceptance-partial",
    };
    const blockedTask = {
      id: "blocked-task",
      itemId: 2,
      title: "Hash paper",
      status: TaskStatus.FAILED,
      progress: 5,
      createdAt: new Date("2026-08-28T00:00:00Z"),
      retryCount: 0,
      maxRetries: 2,
      codexDecision: "BLOCKED",
      failureCode: "codex-source-sha256-mismatch",
    };
    const manager = Object.create(TaskQueueManager.prototype) as any;
    manager.tasks = new Map([
      [partialTask.id, partialTask],
      [blockedTask.id, blockedTask],
    ]);
    manager.deletedFixedTasks = new Map();
    manager.clearedDeletedFixedTaskKeys = new Set();
    try {
      expect(
        manager.shouldSuppressTaskRetry(
          new Error("ordinary failure"),
          partialTask,
        ),
      ).to.equal(true);
      expect(
        manager.shouldSuppressTaskRetry(
          new Error("ordinary failure"),
          blockedTask,
        ),
      ).to.equal(true);
      await manager.saveToStorage();
      const restored = Object.create(TaskQueueManager.prototype) as any;
      restored.tasks = new Map();
      restored.deletedFixedTasks = new Map();
      restored.clearedDeletedFixedTaskKeys = new Set();
      restored.lastLoadedSnapshotAt = null;
      restored.loadFromStorage(false);
      expect(restored.tasks.get(partialTask.id)).to.include({
        codexDecision: "PARTIAL",
        failureCode: "codex-sol-acceptance-partial",
        retryCount: 0,
      });
      expect(restored.tasks.get(blockedTask.id)).to.include({
        codexDecision: "BLOCKED",
        failureCode: "codex-source-sha256-mismatch",
        retryCount: 0,
      });
    } finally {
      globalValue.Zotero = previousZotero;
      globalValue.addon = previousAddon;
      globalValue.ztoolkit = previousToolkit;
    }
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
