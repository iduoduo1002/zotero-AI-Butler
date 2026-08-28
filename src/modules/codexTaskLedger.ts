import { getString } from "../utils/locale";
import type { CodexEventDiagnostic } from "./llmproviders/codexAppServer/types";

export type CodexRole = "sol" | "luna";

export type CodexExecutionStatus =
  | "planned"
  | "running"
  | "awaiting_approval"
  | "passed"
  | "partial"
  | "blocked"
  | "failed";

export interface CodexExecutionContext {
  executionId: string;
  parentExecutionId?: string;
  role: CodexRole;
  model: string;
  reasoningEffort: string;
  itemKey?: string;
  attachmentKey?: string;
  sourceSha256?: string;
  sourceSha256Verified?: boolean;
  sourceSha256Provenance?: string;
  expectedSourceSha256?: string;
  sourceSha256Mismatch?: boolean;
  threadId?: string;
  turnId?: string;
  approvalPolicy: string;
  sandboxPolicy: string;
  networkAccess: boolean;
}

export interface CodexTaskContract {
  executionId: string;
  parentExecutionId?: string;
  taskType: string;
  outputSchema: {
    format: string;
    required: string[];
  };
  inputBoundaries: string[];
  acceptanceDimensions: string[];
  acceptanceCriteria: string[];
  inputSummary: string;
  outputSummary: string;
}

export interface CodexArtifactProbeSummary {
  exists: boolean;
  probeFailed?: boolean;
  reason?: string;
}

export interface CodexExecutionRecord extends CodexExecutionContext {
  status: CodexExecutionStatus;
  recordedAt: string;
  attempt?: number;
  requestId?: string;
  providerExecutionId?: string;
  providerExecutionIds?: string[];
  acceptanceExecutionId?: string;
  outputSummary?: string;
  errorName?: string;
  errorCode?: string;
  errorMessage?: string;
  diagnostics?: CodexEventDiagnostic[];
  contract?: CodexTaskContract;
  artifactProbe?: CodexArtifactProbeSummary;
  acceptance?: "PASS" | "PARTIAL" | "BLOCKED";
}

export interface CodexTaskLedgerFileSystem {
  ensureDirectory(path: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  appendTextFile(path: string, text: string): Promise<void>;
}

export interface CodexTaskLedgerOptions {
  filePath?: string;
  path?: string;
  fileSystem?: CodexTaskLedgerFileSystem;
  now?: () => string;
  idFactory?: () => string;
}

export class CodexTaskLedgerError extends Error {
  constructor(
    public readonly code:
      | "codex-ledger-invalid-status"
      | "codex-ledger-invalid-transition"
      | "codex-ledger-unknown-execution"
      | "codex-ledger-duplicate-execution",
    message = code,
  ) {
    super(message);
    this.name = "CodexTaskLedgerError";
  }
}

export type CodexTaskLedgerQuery = {
  executionId?: string;
  status?: CodexExecutionStatus;
  itemKey?: string;
  attachmentKey?: string;
};

const DEFAULT_LEDGER_DIRECTORY = "ai-butler";
const DEFAULT_LEDGER_FILENAME = "codex-task-ledger.jsonl";
const MAX_TEXT_LENGTH = 512;
const MAX_ERROR_LENGTH = 240;
const EXECUTION_STATUSES: readonly CodexExecutionStatus[] = [
  "planned",
  "running",
  "awaiting_approval",
  "passed",
  "partial",
  "blocked",
  "failed",
];

const ALLOWED_STATUS_TRANSITIONS: Record<
  CodexExecutionStatus,
  readonly CodexExecutionStatus[]
> = {
  planned: ["planned", "running", "blocked", "failed"],
  running: [
    "running",
    "awaiting_approval",
    "passed",
    "partial",
    "blocked",
    "failed",
  ],
  awaiting_approval: [
    "awaiting_approval",
    "passed",
    "partial",
    "blocked",
    "failed",
  ],
  passed: ["passed"],
  partial: ["partial"],
  blocked: ["blocked"],
  failed: ["failed"],
};

const ledgerPathLocks = new Map<string, Promise<void>>();

function isExecutionStatus(value: unknown): value is CodexExecutionStatus {
  return (
    typeof value === "string" &&
    EXECUTION_STATUSES.includes(value as CodexExecutionStatus)
  );
}

function assertExecutionStatus(
  value: unknown,
): asserts value is CodexExecutionStatus {
  if (!isExecutionStatus(value)) {
    throw new CodexTaskLedgerError("codex-ledger-invalid-status");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? path.slice(0, separator) : ".";
}

function defaultLedgerPath(): string {
  const globalValue = globalThis as unknown as {
    Zotero?: { DataDirectory?: { dir?: string } };
    PathUtils?: { join?: (...segments: string[]) => string };
  };
  const dataDirectory = globalValue.Zotero?.DataDirectory?.dir || ".";
  if (typeof globalValue.PathUtils?.join === "function") {
    return globalValue.PathUtils.join(
      dataDirectory,
      DEFAULT_LEDGER_DIRECTORY,
      DEFAULT_LEDGER_FILENAME,
    );
  }
  return `${dataDirectory.replace(/[\\/]$/, "")}/${DEFAULT_LEDGER_DIRECTORY}/${DEFAULT_LEDGER_FILENAME}`;
}

function defaultIdFactory(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `codex-exec-${Date.now().toString(36)}-${random}`;
}

function safeText(
  value: unknown,
  maxLength = MAX_TEXT_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^data:[^,]+;base64,/i.test(trimmed) || /^JVBER/i.test(trimmed)) {
    return "[REDACTED]";
  }
  return trimmed
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/(^|[\s"'(])\/(?!\/)[^\s"'`)]*/g, "$1[PATH]")
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, "[PATH]")
    .slice(0, maxLength);
}

function safeKey(value: unknown): string | undefined {
  return safeText(value, 160);
}

function safeHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hash = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}

function safeSummary(value: unknown): string | undefined {
  const text = safeText(value);
  if (!text) return undefined;
  if (
    /prompt|pdf|base64|full\s*text|document\s*body|api\s*key|secret|token/i.test(
      text,
    )
  ) {
    return "[REDACTED]";
  }
  return text;
}

function safePolicy(value: unknown): string {
  if (typeof value === "string") return safeText(value, 160) || "unknown";
  if (value && typeof value === "object") return "configured";
  return "unknown";
}

function safeDiagnostics(value: unknown): CodexEventDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics = value
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      const method = safeKey(record.method);
      if (!method) return null;
      const result: CodexEventDiagnostic = { method };
      const threadId = safeKey(record.threadId);
      const turnId = safeKey(record.turnId);
      const itemId = safeKey(record.itemId);
      const status = safeKey(record.status);
      const type = safeKey(record.type);
      if (threadId) result.threadId = threadId;
      if (turnId) result.turnId = turnId;
      if (itemId) result.itemId = itemId;
      if (status) result.status = status;
      if (type) result.type = type;
      return result;
    })
    .filter((entry): entry is CodexEventDiagnostic => Boolean(entry))
    .slice(-64);
  return diagnostics.length > 0 ? diagnostics : undefined;
}

function safeContract(value: unknown): CodexTaskContract | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const executionId = safeKey(record.executionId);
  const inputSummary = safeSummary(record.inputSummary);
  const outputSummary = safeSummary(record.outputSummary);
  const taskType = safeKey(record.taskType);
  const outputSchemaRecord = asRecord(record.outputSchema);
  const outputSchemaFormat = safeKey(outputSchemaRecord?.format);
  const outputSchemaRequired = Array.isArray(outputSchemaRecord?.required)
    ? outputSchemaRecord.required
        .map((entry) => safeKey(entry))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 32)
    : [];
  const inputBoundaries = Array.isArray(record.inputBoundaries)
    ? record.inputBoundaries
        .map((entry) => safeSummary(entry))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 32)
    : [];
  const acceptanceDimensions = Array.isArray(record.acceptanceDimensions)
    ? record.acceptanceDimensions
        .map((entry) => safeSummary(entry))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 32)
    : [];
  const acceptanceCriteria = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria
        .map((entry) => safeSummary(entry))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 32)
    : [];
  if (
    !executionId ||
    !taskType ||
    !outputSchemaFormat ||
    !outputSchemaRequired.length ||
    !inputBoundaries.length ||
    !acceptanceDimensions.length ||
    !inputSummary ||
    !outputSummary
  ) {
    return undefined;
  }
  return {
    executionId,
    parentExecutionId: safeKey(record.parentExecutionId),
    taskType,
    outputSchema: {
      format: outputSchemaFormat,
      required: outputSchemaRequired,
    },
    inputBoundaries,
    acceptanceDimensions,
    acceptanceCriteria,
    inputSummary,
    outputSummary,
  };
}

function safeArtifactProbe(
  value: unknown,
): CodexArtifactProbeSummary | undefined {
  const record = asRecord(value);
  if (!record || typeof record.exists !== "boolean") return undefined;
  return {
    exists: record.exists,
    probeFailed:
      typeof record.probeFailed === "boolean" ? record.probeFailed : undefined,
    reason: safeKey(record.reason),
  };
}

function redactRecord(
  value: Record<string, unknown>,
): CodexExecutionRecord | null {
  const executionId = safeKey(value.executionId);
  const status = value.status;
  const role = value.role === "luna" ? "luna" : "sol";
  if (!executionId || !isExecutionStatus(status)) {
    return null;
  }

  const model = safeText(value.model, 160) || "unknown";
  const reasoningEffort = safeText(value.reasoningEffort, 80) || "unknown";
  const record: CodexExecutionRecord = {
    executionId,
    parentExecutionId: safeKey(value.parentExecutionId),
    role,
    model,
    reasoningEffort,
    itemKey: safeKey(value.itemKey),
    attachmentKey: safeKey(value.attachmentKey),
    sourceSha256: safeHash(value.sourceSha256),
    sourceSha256Verified:
      typeof value.sourceSha256Verified === "boolean"
        ? value.sourceSha256Verified
        : undefined,
    sourceSha256Provenance: safeKey(value.sourceSha256Provenance),
    expectedSourceSha256: safeHash(value.expectedSourceSha256),
    sourceSha256Mismatch:
      typeof value.sourceSha256Mismatch === "boolean"
        ? value.sourceSha256Mismatch
        : undefined,
    threadId: safeKey(value.threadId),
    turnId: safeKey(value.turnId),
    approvalPolicy: safePolicy(value.approvalPolicy),
    sandboxPolicy: safePolicy(value.sandboxPolicy),
    networkAccess: value.networkAccess === true,
    status: status as CodexExecutionStatus,
    recordedAt: safeText(value.recordedAt, 80) || new Date(0).toISOString(),
  };
  const attempt = Number(value.attempt);
  if (Number.isFinite(attempt) && attempt >= 0) record.attempt = attempt;
  const requestId = safeKey(value.requestId);
  const providerExecutionId = safeKey(value.providerExecutionId);
  const providerExecutionIds = Array.isArray(value.providerExecutionIds)
    ? value.providerExecutionIds
        .map((entry) => safeKey(entry))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 64)
    : [];
  const acceptanceExecutionId = safeKey(value.acceptanceExecutionId);
  const outputSummary = safeSummary(value.outputSummary);
  const errorName = safeKey(value.errorName);
  const errorCode = safeKey(value.errorCode);
  const errorMessage = safeSummary(value.errorMessage)?.slice(
    0,
    MAX_ERROR_LENGTH,
  );
  const diagnostics = safeDiagnostics(value.diagnostics);
  const contract = safeContract(value.contract);
  const artifactProbe = safeArtifactProbe(value.artifactProbe);
  const acceptance =
    value.acceptance === "PASS" ||
    value.acceptance === "PARTIAL" ||
    value.acceptance === "BLOCKED"
      ? value.acceptance
      : undefined;
  if (requestId) record.requestId = requestId;
  if (providerExecutionId) record.providerExecutionId = providerExecutionId;
  if (providerExecutionIds.length > 0)
    record.providerExecutionIds = providerExecutionIds;
  if (acceptanceExecutionId)
    record.acceptanceExecutionId = acceptanceExecutionId;
  if (outputSummary) record.outputSummary = outputSummary;
  if (errorName) record.errorName = errorName;
  if (errorCode) record.errorCode = errorCode;
  if (errorMessage) record.errorMessage = errorMessage;
  if (diagnostics) record.diagnostics = diagnostics;
  if (contract) record.contract = contract;
  if (artifactProbe) record.artifactProbe = artifactProbe;
  if (acceptance) record.acceptance = acceptance;
  return record;
}

function createDefaultFileSystem(): CodexTaskLedgerFileSystem {
  return {
    async ensureDirectory(path: string): Promise<void> {
      const io = (globalThis as any).IOUtils;
      if (typeof io?.makeDirectory !== "function") {
        throw new Error(getString("common-unknown-error"));
      }
      await io.makeDirectory(path, {
        ignoreExisting: true,
        createAncestors: true,
      });
    },
    async readTextFile(path: string): Promise<string> {
      const io = (globalThis as any).IOUtils;
      if (typeof io?.read !== "function") {
        throw new Error(getString("common-unknown-error"));
      }
      try {
        const value = await io.read(path);
        if (typeof value === "string") return value;
        return new TextDecoder().decode(value);
      } catch {
        return "";
      }
    },
    async appendTextFile(path: string, text: string): Promise<void> {
      const io = (globalThis as any).IOUtils;
      if (typeof io?.write !== "function") {
        throw new Error(getString("common-unknown-error"));
      }
      let previous = "";
      try {
        const value = await io.read(path);
        previous =
          typeof value === "string" ? value : new TextDecoder().decode(value);
      } catch {
        // The file is created on the first append.
      }
      await io.write(path, new TextEncoder().encode(previous + text));
    },
  };
}

export class CodexTaskLedger {
  readonly filePath: string;
  private readonly fileSystem: CodexTaskLedgerFileSystem;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly activeRecords = new Map<string, CodexExecutionRecord>();
  private directoryPromise: Promise<void> | undefined;

  constructor(filePath?: string, options?: CodexTaskLedgerOptions);
  constructor(options?: CodexTaskLedgerOptions);
  constructor(
    filePathOrOptions: string | CodexTaskLedgerOptions = {},
    options: CodexTaskLedgerOptions = {},
  ) {
    const configured =
      typeof filePathOrOptions === "string"
        ? { ...options, filePath: filePathOrOptions }
        : filePathOrOptions;
    this.filePath =
      configured.filePath || configured.path || defaultLedgerPath();
    this.fileSystem = configured.fileSystem || createDefaultFileSystem();
    this.now = configured.now || (() => new Date().toISOString());
    this.idFactory = configured.idFactory || defaultIdFactory;
  }

  static getDefaultPath(): string {
    return defaultLedgerPath();
  }

  async start(
    context: Partial<CodexExecutionContext> = {},
    statusOrDetails: CodexExecutionStatus | Record<string, unknown> = "running",
    details: Record<string, unknown> = {},
  ): Promise<CodexExecutionRecord> {
    const status =
      typeof statusOrDetails === "string"
        ? statusOrDetails
        : statusOrDetails.status === undefined
          ? "running"
          : statusOrDetails.status;
    assertExecutionStatus(status);
    if (status !== "planned" && status !== "running") {
      throw new CodexTaskLedgerError("codex-ledger-invalid-status");
    }
    const startDetails =
      typeof statusOrDetails === "string"
        ? details
        : { ...statusOrDetails, ...details };
    const executionId =
      safeKey(context.executionId) ||
      safeKey(startDetails.executionId) ||
      this.idFactory();
    return this.withPathLock(async () => {
      const existing = await this.readAllUnlocked();
      if (existing.some((record) => record.executionId === executionId)) {
        throw new CodexTaskLedgerError("codex-ledger-duplicate-execution");
      }
      const record = this.buildRecord(
        {
          ...context,
          ...startDetails,
          executionId,
          status,
        },
        context,
      );
      await this.appendUnlocked(record);
      this.activeRecords.set(executionId, record);
      return record;
    });
  }

  async update(
    executionId: string,
    statusOrDetails: CodexExecutionStatus | Record<string, unknown>,
    details: Record<string, unknown> = {},
  ): Promise<CodexExecutionRecord> {
    const status =
      typeof statusOrDetails === "string"
        ? statusOrDetails
        : statusOrDetails.status === undefined
          ? "running"
          : statusOrDetails.status;
    assertExecutionStatus(status);
    const updateDetails =
      typeof statusOrDetails === "string"
        ? details
        : { ...statusOrDetails, ...details };
    const id = safeKey(executionId);
    if (!id) throw new CodexTaskLedgerError("codex-ledger-unknown-execution");
    return this.withPathLock(async () => {
      const previous =
        this.activeRecords.get(id) ||
        (await this.findLatestUnlocked({ executionId: id }));
      if (!previous) {
        throw new CodexTaskLedgerError("codex-ledger-unknown-execution");
      }
      const allowed = ALLOWED_STATUS_TRANSITIONS[previous.status];
      if (!allowed.includes(status)) {
        throw new CodexTaskLedgerError("codex-ledger-invalid-transition");
      }
      const record = this.buildRecord(
        {
          ...previous,
          ...updateDetails,
          executionId: id,
          status,
        },
        previous,
      );
      await this.appendUnlocked(record);
      this.activeRecords.set(id, record);
      return record;
    });
  }

  async complete(
    executionId: string,
    details: Record<string, unknown> = {},
  ): Promise<CodexExecutionRecord> {
    return this.update(executionId, "passed", details);
  }

  async fail(
    executionId: string,
    errorOrDetails?: unknown,
    details: Record<string, unknown> = {},
  ): Promise<CodexExecutionRecord> {
    const errorDetails =
      errorOrDetails instanceof Error
        ? {
            errorName: errorOrDetails.name,
            errorMessage: errorOrDetails.message,
          }
        : asRecord(errorOrDetails) || {};
    return this.update(executionId, "failed", {
      ...errorDetails,
      ...details,
    });
  }

  async readAll(): Promise<CodexExecutionRecord[]> {
    return this.withPathLock(() => this.readAllUnlocked());
  }

  private async readAllUnlocked(): Promise<CodexExecutionRecord[]> {
    await this.ensureDirectory();
    let text: string;
    try {
      text = await this.fileSystem.readTextFile(this.filePath);
    } catch {
      return [];
    }
    const records: CodexExecutionRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const record = redactRecord(asRecord(parsed) || {});
        if (record) records.push(record);
      } catch {
        // A truncated or manually edited line must not hide later records.
      }
    }
    return records;
  }

  async query(
    query: CodexTaskLedgerQuery | string = {},
  ): Promise<CodexExecutionRecord[]> {
    const normalizedQuery =
      typeof query === "string" ? { itemKey: query } : query;
    const records = await this.readAll();
    return records.filter((record) => {
      if (
        normalizedQuery.executionId &&
        record.executionId !== normalizedQuery.executionId
      ) {
        return false;
      }
      if (normalizedQuery.status && record.status !== normalizedQuery.status) {
        return false;
      }
      if (
        normalizedQuery.itemKey &&
        record.itemKey !== normalizedQuery.itemKey
      ) {
        return false;
      }
      if (
        normalizedQuery.attachmentKey &&
        record.attachmentKey !== normalizedQuery.attachmentKey
      ) {
        return false;
      }
      return true;
    });
  }

  async findLatest(
    query: CodexTaskLedgerQuery | string = {},
  ): Promise<CodexExecutionRecord | null> {
    const records = await this.query(query);
    return records.length > 0 ? records[records.length - 1] : null;
  }

  private async findLatestUnlocked(
    query: CodexTaskLedgerQuery | string = {},
  ): Promise<CodexExecutionRecord | null> {
    const normalizedQuery =
      typeof query === "string" ? { itemKey: query } : query;
    const records = await this.readAllUnlocked();
    const matching = records.filter((record) => {
      if (
        normalizedQuery.executionId &&
        record.executionId !== normalizedQuery.executionId
      ) {
        return false;
      }
      if (normalizedQuery.status && record.status !== normalizedQuery.status) {
        return false;
      }
      if (
        normalizedQuery.itemKey &&
        record.itemKey !== normalizedQuery.itemKey
      ) {
        return false;
      }
      if (
        normalizedQuery.attachmentKey &&
        record.attachmentKey !== normalizedQuery.attachmentKey
      ) {
        return false;
      }
      return true;
    });
    return matching.length > 0 ? matching[matching.length - 1] : null;
  }

  private buildRecord(
    value: Record<string, unknown>,
    fallback: Partial<CodexExecutionContext> | CodexExecutionRecord,
  ): CodexExecutionRecord {
    const base: Record<string, unknown> = {
      executionId: value.executionId,
      parentExecutionId: value.parentExecutionId ?? fallback.parentExecutionId,
      role: value.role ?? fallback.role ?? "sol",
      model: value.model ?? fallback.model ?? "unknown",
      reasoningEffort:
        value.reasoningEffort ?? fallback.reasoningEffort ?? "unknown",
      itemKey: value.itemKey ?? fallback.itemKey,
      attachmentKey: value.attachmentKey ?? fallback.attachmentKey,
      sourceSha256: value.sourceSha256 ?? fallback.sourceSha256,
      sourceSha256Verified:
        value.sourceSha256Verified ?? fallback.sourceSha256Verified,
      sourceSha256Provenance:
        value.sourceSha256Provenance ?? fallback.sourceSha256Provenance,
      expectedSourceSha256:
        value.expectedSourceSha256 ?? fallback.expectedSourceSha256,
      sourceSha256Mismatch:
        value.sourceSha256Mismatch ?? fallback.sourceSha256Mismatch,
      threadId: value.threadId ?? fallback.threadId,
      turnId: value.turnId ?? fallback.turnId,
      approvalPolicy:
        value.approvalPolicy ?? fallback.approvalPolicy ?? "unknown",
      sandboxPolicy: value.sandboxPolicy ?? fallback.sandboxPolicy ?? "unknown",
      networkAccess: value.networkAccess ?? fallback.networkAccess ?? false,
      status: value.status,
      recordedAt: this.now(),
      ...value,
    };
    const record = redactRecord(base);
    if (!record) throw new Error(getString("common-unknown-error"));
    return record;
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.directoryPromise) {
      this.directoryPromise = this.fileSystem.ensureDirectory(
        parentDirectory(this.filePath),
      );
    }
    await this.directoryPromise;
  }

  private async appendUnlocked(record: CodexExecutionRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    await this.ensureDirectory();
    let separator = "";
    try {
      const existing = await this.fileSystem.readTextFile(this.filePath);
      if (existing && !/\r?\n$/.test(existing)) separator = "\n";
    } catch {
      // The append operation creates a missing file.
    }
    await this.fileSystem.appendTextFile(this.filePath, separator + line);
  }

  private async withPathLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = ledgerPathLocks.get(this.filePath) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockPromise = previous.catch(() => undefined).then(() => gate);
    ledgerPathLocks.set(this.filePath, lockPromise);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      const current = ledgerPathLocks.get(this.filePath);
      if (current === lockPromise) ledgerPathLocks.delete(this.filePath);
    }
  }
}

export default CodexTaskLedger;
