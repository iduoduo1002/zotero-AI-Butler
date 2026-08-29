import { expect } from "chai";
import {
  CodexTaskLedger,
  CodexTaskLedgerError,
  type CodexExecutionContext,
  type CodexTaskLedgerFileSystem,
} from "../src/modules/codexTaskLedger";

class MemoryLedgerFileSystem implements CodexTaskLedgerFileSystem {
  content = "";
  readonly directories: string[] = [];

  async ensureDirectory(path: string): Promise<void> {
    this.directories.push(path);
  }

  async readTextFile(): Promise<string> {
    return this.content;
  }

  async appendTextFile(_path: string, text: string): Promise<void> {
    this.content += text;
  }
}

function context(overrides: Partial<CodexExecutionContext> = {}) {
  return {
    role: "luna" as const,
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    itemKey: "ITEM-1",
    attachmentKey: "ATTACH-1",
    sourceSha256: "a".repeat(64),
    approvalPolicy: "on-request",
    sandboxPolicy: "read-only",
    networkAccess: false,
    ...overrides,
  };
}

describe("CodexTaskLedger", function () {
  it("assigns a stable execution id and appends status transitions", async function () {
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ai-butler/ledger.jsonl", {
      fileSystem,
      idFactory: () => "exec-stable",
      now: () => "2026-08-28T00:00:00.000Z",
    });

    const started = await ledger.start(context(), "planned");
    await ledger.update(started.executionId, "running");
    await ledger.complete(started.executionId, {
      outputSummary: "redacted output summary",
    });

    const records = await ledger.readAll();
    expect(records.map((record) => record.executionId)).to.deep.equal([
      "exec-stable",
      "exec-stable",
      "exec-stable",
    ]);
    expect(records.map((record) => record.status)).to.deep.equal([
      "planned",
      "running",
      "passed",
    ]);
    expect(records[2].outputSummary).to.equal("redacted output summary");
    expect(fileSystem.directories).to.deep.equal(["/tmp/ai-butler"]);
  });

  it("never persists prompts, document bodies, credentials, or absolute paths", async function () {
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ai-butler/ledger.jsonl", {
      fileSystem,
      idFactory: () => "exec-redacted",
    });

    const started = await ledger.start(
      context({
        itemKey: "ITEM-SECRET",
        sourceSha256: "b".repeat(64),
      }),
      "running",
      {
        prompt: "PRIVATE_PROMPT_SHOULD_NOT_BE_WRITTEN",
        pdfText: "PRIVATE_PDF_BODY_SHOULD_NOT_BE_WRITTEN",
        base64Content: "JVBERi0xLjQKPRIVATE_BASE64_SHOULD_NOT_BE_WRITTEN",
        apiKey: "sk-private-key",
        authorization: "Bearer private-bearer-token",
        filePath: "/Users/alater/private-paper.pdf",
      },
    );
    await ledger.complete(started.executionId, {
      outputSummary: "PRIVATE_PROMPT_SHOULD_NOT_BE_WRITTEN",
    });

    expect(fileSystem.content).not.to.contain("PRIVATE_PROMPT");
    expect(fileSystem.content).not.to.contain("PRIVATE_PDF_BODY");
    expect(fileSystem.content).not.to.contain("PRIVATE_BASE64");
    expect(fileSystem.content).not.to.contain("sk-private-key");
    expect(fileSystem.content).not.to.contain("private-bearer-token");
    expect(fileSystem.content).not.to.contain("/Users/alater");
    expect(fileSystem.content).to.contain("ITEM-SECRET");
    expect(fileSystem.content).to.contain("sourceSha256");
  });

  it("ignores malformed previous lines and queries the latest matching record", async function () {
    const fileSystem = new MemoryLedgerFileSystem();
    fileSystem.content = [
      "not-json",
      JSON.stringify({
        ...context(),
        executionId: "old-exec",
        status: "failed",
      }),
    ].join("\n");
    const ledger = new CodexTaskLedger("/tmp/ai-butler/ledger.jsonl", {
      fileSystem,
      idFactory: () => "new-exec",
      now: () => "2026-08-28T00:00:00.000Z",
    });

    await ledger.start(context({ itemKey: "ITEM-1" }));
    await ledger.fail("new-exec", new Error("safe failure"));

    const latestByItem = await ledger.findLatest({ itemKey: "ITEM-1" });
    const latestByExecution = await ledger.findLatest({
      executionId: "new-exec",
    });
    const failed = await ledger.query({ status: "failed" });

    expect(latestByItem?.executionId).to.equal("new-exec");
    expect(latestByItem?.status).to.equal("failed");
    expect(latestByExecution?.status).to.equal("failed");
    expect(failed.map((record) => record.executionId)).to.deep.equal([
      "old-exec",
      "new-exec",
    ]);
  });

  it("rejects unknown execution updates and terminal-to-running transitions", async function () {
    const fileSystem = new MemoryLedgerFileSystem();
    const ledger = new CodexTaskLedger("/tmp/ai-butler/ledger-state.jsonl", {
      fileSystem,
      idFactory: () => "terminal-exec",
    });
    const started = await ledger.start(context(), "running");
    await ledger.complete(started.executionId);

    let unknownError: unknown;
    try {
      await ledger.update("missing-exec", "running");
    } catch (error) {
      unknownError = error;
    }
    expect(unknownError).to.be.instanceOf(CodexTaskLedgerError);
    expect((unknownError as CodexTaskLedgerError).code).to.equal(
      "codex-ledger-unknown-execution",
    );

    let transitionError: unknown;
    try {
      await ledger.update(started.executionId, "running");
    } catch (error) {
      transitionError = error;
    }
    expect(transitionError).to.be.instanceOf(CodexTaskLedgerError);
    expect((transitionError as CodexTaskLedgerError).code).to.equal(
      "codex-ledger-invalid-transition",
    );

    let invalidStatusError: unknown;
    try {
      await ledger.update(started.executionId, { status: "not-a-status" });
    } catch (error) {
      invalidStatusError = error;
    }
    expect(invalidStatusError).to.be.instanceOf(CodexTaskLedgerError);
    expect((invalidStatusError as CodexTaskLedgerError).code).to.equal(
      "codex-ledger-invalid-status",
    );
  });

  it("serializes concurrent instances and retains a malformed tail", async function () {
    const fileSystem = new MemoryLedgerFileSystem();
    const first = new CodexTaskLedger("/tmp/ai-butler/concurrent.jsonl", {
      fileSystem,
      idFactory: () => "first-exec",
    });
    const second = new CodexTaskLedger("/tmp/ai-butler/concurrent.jsonl", {
      fileSystem,
      idFactory: () => "second-exec",
    });

    await Promise.all([
      first.start(context({ itemKey: "ITEM-FIRST" }), "running"),
      second.start(context({ itemKey: "ITEM-SECOND" }), "running"),
    ]);
    fileSystem.content += '{"truncated":';
    await first.update("first-exec", "awaiting_approval");

    const records = await first.readAll();
    expect(records.map((record) => record.executionId)).to.include.members([
      "first-exec",
      "second-exec",
    ]);
    expect(records.at(-1)?.status).to.equal("awaiting_approval");
  });

  it("uses the default IOUtils atomic adapter without corrupting a partial write", async function () {
    const globalValue = globalThis as any;
    const previousIo = globalValue.IOUtils;
    const filePath = "/tmp/ai-butler/default-adapter.jsonl";
    const files = new Map<string, Uint8Array>();
    let failWrite = false;
    const atomicCalls: Array<{ path: string; tmpPath?: string }> = [];
    globalValue.IOUtils = {
      makeDirectory: async () => undefined,
      read: async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error("missing file");
        return bytes;
      },
      writeAtomic: async (
        path: string,
        bytes: Uint8Array,
        options?: { tmpPath?: string },
      ) => {
        atomicCalls.push({ path, tmpPath: options?.tmpPath });
        if (failWrite) throw new Error("simulated partial write");
        files.set(path, new Uint8Array(bytes));
      },
    };

    try {
      const ledger = new CodexTaskLedger(filePath, {
        idFactory: () => "default-adapter-exec",
      });
      const started = await ledger.start(context(), "running");
      const beforeFailedWrite = new Uint8Array(files.get(filePath)!);
      failWrite = true;

      let thrown: unknown;
      try {
        await ledger.update(started.executionId, "awaiting_approval");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect(Array.from(files.get(filePath)!)).to.deep.equal(
        Array.from(beforeFailedWrite),
      );
      expect(
        (await ledger.readAll()).map((record) => record.status),
      ).to.deep.equal(["running"]);

      failWrite = false;
      await ledger.update(started.executionId, "awaiting_approval");
      expect(atomicCalls).to.have.length(3);
      expect(atomicCalls.every((call) => call.path === filePath)).to.equal(
        true,
      );
      expect(
        atomicCalls.every((call) =>
          call.tmpPath?.startsWith(`${filePath}.tmp-`),
        ),
      ).to.equal(true);
      expect(
        (await ledger.readAll()).map((record) => record.status),
      ).to.deep.equal(["running", "awaiting_approval"]);
    } finally {
      globalValue.IOUtils = previousIo;
    }
  });
});
