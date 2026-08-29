import type { LLMAbortSignal } from "../types";
import type {
  CodexAppServerClientOptions,
  CodexAppServerEvent,
  CodexAppServerProcessLike,
  CodexAppServerRunTurnParams,
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSandboxPolicy,
  CodexEventDiagnostic,
  CodexTurnResult,
} from "./types";
import { getString } from "../../../utils/locale";
import { providerRequestFailed } from "../shared/localizedErrors";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type EventListener = (event: CodexAppServerEvent) => void | Promise<void>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNestedId(value: unknown, key: "thread" | "turn"): string {
  const record = asRecord(value);
  const direct = readString(record?.id);
  if (direct) return direct;
  const nested = asRecord(record?.[key]);
  return readString(nested?.id) || "";
}

function readTurnStatus(params: unknown): string {
  const record = asRecord(params);
  const nested = asRecord(record?.turn);
  return readString(nested?.status) || readString(record?.status) || "unknown";
}

function readEventId(params: unknown, key: "threadId" | "turnId"): string {
  const record = asRecord(params);
  const direct = readString(record?.[key]);
  if (direct) return direct;
  const nested = asRecord(record?.[key === "turnId" ? "turn" : "thread"]);
  return readString(nested?.id) || readString(nested?.[key]) || "";
}

function safeText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(^|[\s"'(])\/[^\s"'`)]*/g, "$1[PATH]")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[PATH]")
    .slice(0, maxLength);
}

function codexError(fallback: string): string {
  try {
    return providerRequestFailed("Codex App Server");
  } catch {
    return fallback;
  }
}

function policyError(code: string): Error {
  return new Error(code);
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isAbsolutePath(value: string): boolean {
  return (
    /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
  );
}

function normalizeApprovalPolicy(
  value: unknown,
): CodexApprovalPolicy | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "untrusted" || value === "on-request" || value === "never") {
    return value;
  }
  const record = asRecord(value);
  if (!record || !hasOnlyKeys(record, ["granular"])) {
    throw policyError("codex-approval-policy-invalid");
  }
  const granular = asRecord(record?.granular);
  if (!granular) throw policyError("codex-approval-policy-invalid");
  if (
    !hasOnlyKeys(granular, [
      "sandbox_approval",
      "sandboxApproval",
      "rules",
      "skill_approval",
      "skillApproval",
      "request_permissions",
      "requestPermissions",
      "mcp_elicitations",
      "mcpElicitations",
    ])
  ) {
    throw policyError("codex-approval-policy-invalid");
  }
  const readBoolean = (snake: string, camel: string): boolean => {
    const candidate = granular[snake] ?? granular[camel];
    if (typeof candidate !== "boolean") {
      throw policyError("codex-approval-policy-invalid");
    }
    return candidate;
  };
  return {
    granular: {
      sandbox_approval: readBoolean("sandbox_approval", "sandboxApproval"),
      rules: readBoolean("rules", "rules"),
      skill_approval: readBoolean("skill_approval", "skillApproval"),
      request_permissions: readBoolean(
        "request_permissions",
        "requestPermissions",
      ),
      mcp_elicitations: readBoolean("mcp_elicitations", "mcpElicitations"),
    },
  };
}

type NormalizedPolicies = {
  approvalPolicy?: CodexApprovalPolicy;
  threadSandbox?: CodexSandboxMode;
  sandboxPolicy?: CodexSandboxPolicy;
};

function normalizeSandboxPolicy(
  value: unknown,
  networkAccess: unknown,
): Pick<NormalizedPolicies, "threadSandbox" | "sandboxPolicy"> {
  if (networkAccess !== undefined && typeof networkAccess !== "boolean") {
    throw policyError("codex-network-policy-invalid");
  }
  const network = networkAccess as boolean | undefined;
  if (value === undefined || value === null || value === "") {
    return network === undefined
      ? {}
      : { sandboxPolicy: { type: "readOnly", networkAccess: network } };
  }

  if (value === "read-only") {
    return {
      threadSandbox: value,
      sandboxPolicy: { type: "readOnly", networkAccess: network ?? false },
    };
  }
  if (value === "workspace-write") {
    return {
      threadSandbox: value,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: network ?? false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
  }
  if (value === "danger-full-access") {
    if (network !== undefined) {
      throw policyError("codex-network-policy-invalid");
    }
    return {
      threadSandbox: value,
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }

  const record = asRecord(value);
  if (!record) throw policyError("codex-sandbox-policy-invalid");
  const type = record?.type;
  if (type === "dangerFullAccess") {
    if (!hasOnlyKeys(record, ["type"])) {
      throw policyError("codex-sandbox-policy-invalid");
    }
    if (network !== undefined)
      throw policyError("codex-network-policy-invalid");
    return {
      threadSandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  if (type === "readOnly") {
    if (!hasOnlyKeys(record, ["type", "networkAccess"])) {
      throw policyError("codex-sandbox-policy-invalid");
    }
    if (typeof record?.networkAccess !== "boolean") {
      throw policyError("codex-sandbox-policy-invalid");
    }
    return {
      threadSandbox: "read-only",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: network ?? record.networkAccess,
      },
    };
  }
  if (type === "workspaceWrite") {
    if (
      !hasOnlyKeys(record, [
        "type",
        "writableRoots",
        "networkAccess",
        "excludeTmpdirEnvVar",
        "excludeSlashTmp",
      ])
    ) {
      throw policyError("codex-sandbox-policy-invalid");
    }
    const roots = record.writableRoots;
    if (
      !Array.isArray(roots) ||
      !roots.every(
        (root): root is string =>
          typeof root === "string" && isAbsolutePath(root),
      ) ||
      typeof record.networkAccess !== "boolean" ||
      typeof record.excludeTmpdirEnvVar !== "boolean" ||
      typeof record.excludeSlashTmp !== "boolean"
    ) {
      throw policyError("codex-sandbox-policy-invalid");
    }
    return {
      threadSandbox: "workspace-write",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: roots,
        networkAccess: network ?? record.networkAccess,
        excludeTmpdirEnvVar: record.excludeTmpdirEnvVar,
        excludeSlashTmp: record.excludeSlashTmp,
      },
    };
  }
  throw policyError("codex-sandbox-policy-invalid");
}

function normalizePolicies(
  params: CodexAppServerRunTurnParams,
): NormalizedPolicies {
  if (
    params.mcpEnabled !== undefined &&
    typeof params.mcpEnabled !== "boolean"
  ) {
    throw policyError("codex-mcp-policy-invalid");
  }
  if (params.mcpEnabled === true) {
    throw policyError("codex-mcp-reserved");
  }
  return {
    approvalPolicy: normalizeApprovalPolicy(params.approvalPolicy),
    ...normalizeSandboxPolicy(params.sandboxPolicy, params.networkAccess),
  };
}

function makeRequestError(method: string, error: unknown): Error {
  const record = asRecord(error);
  const code =
    typeof record?.code === "number"
      ? String(record.code)
      : safeText(record?.code, 40);
  // Do not forward the server's message: app-server versions have echoed user
  // input in error text in the past. The method/code remain actionable while
  // keeping the provider boundary content-safe.
  return new Error(
    `Codex app-server request failed: ${method}${code ? ` (${code})` : ""}`,
  );
}

function redactDiagnostic(
  method: string,
  params: unknown,
): CodexEventDiagnostic {
  const record = asRecord(params);
  const turn = asRecord(record?.turn);
  const item = asRecord(record?.item);
  const diagnostic: CodexEventDiagnostic = { method };
  const threadId =
    readString(record?.threadId) || readString(asRecord(record?.thread)?.id);
  const turnId =
    readString(record?.turnId) ||
    readString(turn?.id) ||
    readString(item?.turnId);
  const itemId = readString(record?.itemId) || readString(item?.id);
  const status = readString(record?.status) || readString(turn?.status);
  const type = readString(record?.type) || readString(item?.type);

  if (threadId) diagnostic.threadId = threadId.slice(0, 160);
  if (turnId) diagnostic.turnId = turnId.slice(0, 160);
  if (itemId) diagnostic.itemId = itemId.slice(0, 160);
  if (status) diagnostic.status = safeText(status, 80);
  if (type) diagnostic.type = safeText(type, 80);
  return diagnostic;
}

function makeAbortError(): Error {
  let message = "codex-turn-aborted";
  try {
    message = getString("provider-error-aborted");
  } catch {
    // Unit tests and early startup can run without the Zotero locale runtime.
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function makeProcessExitError(code?: number, diagnostics?: string): Error {
  const safeDiagnostics = safeText(diagnostics, 4000)
    ?.replace(/\s+/g, " ")
    .trim();
  return new Error(
    `Codex app-server process exited${code === undefined ? "" : ` with code ${code}`}${safeDiagnostics ? `: ${safeDiagnostics}` : ""}`,
  );
}

function isAborted(signal?: LLMAbortSignal): boolean {
  return Boolean(signal?.aborted);
}

/** Minimal JSONL JSON-RPC client for one Codex app-server subprocess. */
export class CodexAppServerClient {
  private readonly process: CodexAppServerProcessLike;
  private readonly options: CodexAppServerClientOptions;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly activeTurnRejectors = new Set<(error: Error) => void>();
  private readonly processUnsubscribers: Array<() => void> = [];
  private nextRequestId = 1;
  private lineBuffer = "";
  private initialization: Promise<void> | undefined;
  private initialized = false;
  private closed = false;
  private processExitError: Error | undefined;

  constructor(
    process: CodexAppServerProcessLike,
    options: CodexAppServerClientOptions = {},
  ) {
    this.process = process;
    this.options = options;
    this.registerProcessListeners();
  }

  /** Public for small protocol consumers and for deterministic fake-process tests. */
  request(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        this.processExitError || new Error(codexError("codex-client-closed")),
      );
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: (value) => {
          if (pending.timer) clearTimeout(pending.timer);
          this.pending.delete(id);
          resolve(value);
        },
        reject: (error) => {
          if (pending.timer) clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(error);
        },
      };
      this.pending.set(id, pending);
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(new Error(`Codex app-server request timed out: ${method}`));
        }, timeoutMs);
      }
      try {
        const writeResult = this.process.write(
          `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
        );
        if (
          writeResult &&
          typeof (writeResult as Promise<void>).catch === "function"
        ) {
          void (writeResult as Promise<void>).catch((error) => {
            pending.reject(error);
          });
        }
      } catch (error) {
        pending.reject(error);
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      const result = this.process.write(
        `${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`,
      );
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // The process exit handler rejects the active operation if needed.
    }
  }

  async runTurn(params: CodexAppServerRunTurnParams): Promise<CodexTurnResult> {
    if (isAborted(params.abortSignal)) throw makeAbortError();
    if (!params.executionId?.trim()) {
      throw new Error(codexError("codex-execution-id-required"));
    }
    const policies = normalizePolicies(params);
    const diagnostics: CodexEventDiagnostic[] = [];
    const eventTasks: Promise<void>[] = [];
    let threadId = params.threadId?.trim() || "";
    let turnId = "";
    let text = "";
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    let unsubscribeEvents: (() => void) | undefined;
    let rejectActiveTurn: ((error: Error) => void) | undefined;
    let taskProcessKilled = false;

    const resultPromise = new Promise<CodexTurnResult>((resolve, reject) => {
      const cleanup = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (abortHandler) {
          params.abortSignal?.removeEventListener?.("abort", abortHandler);
        }
        unsubscribeEvents?.();
        if (rejectActiveTurn) this.activeTurnRejectors.delete(rejectActiveTurn);
      };
      const resolveResult = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const eventDiagnostics = diagnostics.slice();
        resolve({
          threadId,
          turnId,
          text,
          diagnostics: eventDiagnostics,
          events: eventDiagnostics,
        });
      };
      const rejectResult = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onEvent: EventListener = (event) => {
        diagnostics.push(redactDiagnostic(event.method, event.params));
        const record = asRecord(event.params);
        const eventTurnId = readEventId(event.params, "turnId");
        if (!turnId && eventTurnId) turnId = eventTurnId;
        if (eventTurnId && turnId && eventTurnId !== turnId) return;

        if (event.method === "item/agentMessage/delta") {
          const deltaValue = record?.delta ?? record?.text;
          if (typeof deltaValue === "string") text += deltaValue;
        }

        let callbackTask: Promise<void>;
        try {
          callbackTask = Promise.resolve(params.onEvent?.(event)).catch(
            () => undefined,
          );
        } catch {
          callbackTask = Promise.resolve();
        }
        eventTasks.push(callbackTask);

        if (event.method !== "turn/completed") return;
        const status = readTurnStatus(event.params);
        if (status !== "completed") {
          rejectResult(
            new Error(
              `Codex turn ${turnId || eventTurnId || "unknown"} ended with status ${status}`,
            ),
          );
          return;
        }
        void Promise.all(eventTasks).then(resolveResult, () => resolveResult());
      };

      this.eventListeners.add(onEvent);
      unsubscribeEvents = () => this.eventListeners.delete(onEvent);

      rejectActiveTurn = (error) => rejectResult(error);
      this.activeTurnRejectors.add(rejectActiveTurn);

      const killTaskProcess = () => {
        if (taskProcessKilled) return;
        taskProcessKilled = true;
        try {
          const killResult = this.process.kill();
          if (
            killResult &&
            typeof (killResult as Promise<void>).catch === "function"
          ) {
            void (killResult as Promise<void>).catch(() => undefined);
          }
        } catch {
          // Preserve the original cancellation/timeout error.
        }
      };

      const interrupt = () => {
        if (settled) return;
        const abortError = makeAbortError();
        rejectResult(abortError);
        if (threadId && turnId) {
          void this.request(
            "turn/interrupt",
            { threadId, turnId },
            Math.min(this.options.requestTimeoutMs ?? 5_000, 5_000),
          ).catch(() => killTaskProcess());
        } else {
          // A turn may already be running while the turn/start response is in
          // flight. Kill this task-scoped process rather than leaving a
          // background turn with no interruptible id.
          killTaskProcess();
        }
      };
      abortHandler = interrupt;
      params.abortSignal?.addEventListener?.("abort", abortHandler, {
        once: true,
      });
      if (isAborted(params.abortSignal)) {
        interrupt();
        return;
      }

      const turnTimeoutMs =
        params.timeoutMs ??
        this.options.turnTimeoutMs ??
        DEFAULT_TURN_TIMEOUT_MS;
      if (turnTimeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (settled) return;
          const timeoutError = new Error(
            `Codex app-server turn timed out after ${turnTimeoutMs}ms`,
          );
          rejectResult(timeoutError);
          if (threadId && turnId) {
            void this.request(
              "turn/interrupt",
              { threadId, turnId },
              Math.min(this.options.requestTimeoutMs ?? 5_000, 5_000),
            ).catch(() => undefined);
          }
          killTaskProcess();
        }, turnTimeoutMs);
      }

      void (async () => {
        try {
          await this.ensureInitialized();
          if (settled) return;

          if (!threadId) {
            const threadResult = await this.request("thread/start", {
              model: params.model,
              ...(policies.approvalPolicy
                ? { approvalPolicy: policies.approvalPolicy }
                : {}),
              ...(policies.threadSandbox
                ? { sandbox: policies.threadSandbox }
                : {}),
            });
            threadId = readNestedId(threadResult, "thread");
            if (!threadId) {
              throw new Error(codexError("codex-thread-id-missing"));
            }
          }

          const turnResult = await this.request("turn/start", {
            threadId,
            input: [{ type: "text", text: params.input, text_elements: [] }],
            model: params.model,
            effort: params.reasoningEffort,
            clientUserMessageId: params.executionId,
            ...(policies.approvalPolicy
              ? { approvalPolicy: policies.approvalPolicy }
              : {}),
            ...(policies.sandboxPolicy
              ? { sandboxPolicy: policies.sandboxPolicy }
              : {}),
          });
          turnId = readNestedId(turnResult, "turn");
          if (!turnId) {
            throw new Error(codexError("codex-turn-id-missing"));
          }
        } catch (error) {
          rejectResult(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      })();
    });

    return resultPromise;
  }

  /** Stop this client and its task-scoped process. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(codexError("codex-client-closed"));
    this.processExitError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const reject of this.activeTurnRejectors) reject(error);
    for (const unsubscribe of this.processUnsubscribers) unsubscribe();
    this.processUnsubscribers.length = 0;
    try {
      const result = this.process.kill();
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // No further action is possible after close.
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      await this.request("initialize", {
        clientInfo: {
          name: this.options.clientName || "zotero-ai-butler",
          title: this.options.clientTitle || "Zotero AI Butler",
          version: this.options.clientVersion || "1.0.0",
        },
        capabilities: { experimentalApi: true },
      });
      this.sendNotification("initialized");
      this.initialized = true;
    })();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private registerProcessListeners(): void {
    const onLineResult = this.process.onLine((line) => this.handleLine(line));
    if (typeof onLineResult === "function") {
      this.processUnsubscribers.push(onLineResult);
    }
    const onExitResult = this.process.onExit((code) => this.handleExit(code));
    if (typeof onExitResult === "function") {
      this.processUnsubscribers.push(onExitResult);
    }
  }

  private handleLine(line: string): void {
    this.lineBuffer += line;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() || "";
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        this.handleMessage(JSON.parse(trimmed) as JsonRpcMessage);
      } catch {
        // Invalid server output is ignored; request timeout/process exit remains visible.
      }
    }
    // Test doubles commonly deliver one complete line without its delimiter.
    // Keep partial JSON buffered, but do not require a trailing newline for a
    // complete JSON-RPC message.
    if (this.lineBuffer.trim()) {
      try {
        this.handleMessage(JSON.parse(this.lineBuffer) as JsonRpcMessage);
        this.lineBuffer = "";
      } catch {
        // Wait for the next chunk when the JSON line is incomplete.
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        if (message.error !== undefined) {
          pending.reject(makeRequestError(pending.method, message.error));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    if (typeof message.method !== "string") return;
    const event: CodexAppServerEvent = {
      ...(message.id === undefined ? {} : { id: message.id }),
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    };
    for (const listener of this.eventListeners) {
      try {
        void listener(event);
      } catch {
        // Event consumers cannot break the JSONL reader.
      }
    }
  }

  private handleExit(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    const diagnostics = this.process.getDiagnostics?.();
    const error = makeProcessExitError(code, diagnostics);
    this.processExitError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const reject of this.activeTurnRejectors) reject(error);
  }
}

export default CodexAppServerClient;
