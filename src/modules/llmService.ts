/**
 * 统一 LLM 中间件。
 *
 * 上层功能只描述任务、提示词和内容来源；本层负责：
 * - 读取 Provider 与通用配置
 * - 按 Provider 能力选择 PDF/Base64/Text 输入形态
 * - 执行密钥轮换与重试
 * - 返回统一 LLMResponse
 */
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { getConfiguredSummaryPrompt } from "../utils/prompts";
import { ApiKeyManager, type ProviderId } from "./apiKeyManager";
import {
  LLMEndpointManager,
  type LLMEndpoint,
  type LLMPdfProcessMode,
} from "./llmEndpointManager";
import { ContentExtractor } from "./contentExtractor";
import { PDFExtractor } from "./pdfExtractor";
import type { TaskProgressMeta } from "./taskQueue";
import { ProviderRegistry } from "./llmproviders/ProviderRegistry";
import "./llmproviders";
import type { ILlmProvider, PdfFileInfo } from "./llmproviders/ILlmProvider";
import type { ConnectionTestMode } from "./llmproviders/shared/connectionTest";
import {
  normalizeReasoningEffortSetting,
  resolveReasoningEffort,
} from "./llmproviders/shared/reasoning";
import { sanitizeLLMOutputText } from "./llmproviders/shared/outputSanitizer";
import {
  isAutoContinuableTruncation,
  resetTruncationState,
} from "./llmproviders/shared/truncation";
import {
  createAbortError,
  isAbortError,
  normalizeAbortError,
  throwIfAborted,
} from "./llmproviders/shared/requestAbort";
import type {
  ConversationMessage,
  LLMAbortSignal,
  LLMOptions,
  LLMModelInfo,
  LLMProviderCapabilities,
  LLMReasoningEffortSetting,
  LLMResponse,
  ProgressCb,
} from "./llmproviders/types";
import { CodexTaskLedger, type CodexExecutionContext } from "./codexTaskLedger";

export type LLMTask =
  | "summary"
  | "mindmap"
  | "table"
  | "literature-review"
  | "chat"
  | "image-summary"
  | "custom";

export type LLMContentPolicy = "auto" | "text" | "pdf-base64" | "mineru";
export type LLMAttachmentMode = "default" | "all";

export type LLMTextContent = {
  kind: "text";
  text: string;
  policy?: LLMContentPolicy;
};

export type LLMZoteroItemContent = {
  kind: "zotero-item";
  item: Zotero.Item;
  policy?: LLMContentPolicy;
  attachmentMode?: LLMAttachmentMode;
  maxAttachments?: number;
};

export type LLMPdfAttachmentContent = {
  kind: "pdf-attachment";
  item?: Zotero.Item;
  attachment: Zotero.Item;
  policy?: LLMContentPolicy;
};

export type LLMAnalyzableAttachmentContent = {
  kind: "analyzable-attachment";
  item?: Zotero.Item;
  attachment: Zotero.Item;
  policy?: LLMContentPolicy;
};

export type LLMPdfFileInput = PdfFileInfo & {
  textContent?: string;
};

export type LLMPdfFilesContent = {
  kind: "pdf-files";
  files: LLMPdfFileInput[];
  policy?: LLMContentPolicy;
  maxAttachments?: number;
};

type LLMLegacyContent = {
  kind: "legacy";
  content: string;
  isBase64: boolean;
  policy?: LLMContentPolicy;
};

export type LLMContentInput =
  | LLMTextContent
  | LLMZoteroItemContent
  | LLMPdfAttachmentContent
  | LLMAnalyzableAttachmentContent
  | LLMPdfFilesContent
  | LLMLegacyContent;

export type LLMGenerationOptions = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoningEffort?: LLMReasoningEffortSetting;
  verbosity?: string;
  responseFormat?: string;
  vendorOptions?: Record<string, unknown>;
};

export type LLMLifecycleEvent = TaskProgressMeta & {
  progress?: number;
  message?: string;
};

export type LLMLifecycleCallback = (event: LLMLifecycleEvent) => void;

export type LLMTransportOptions = {
  stream?: boolean;
  timeoutMs?: number;
  retry?: boolean;
  keyRotation?: boolean;
  abortSignal?: LLMAbortSignal;
  onStatus?: LLMLifecycleCallback;
};

export type LLMGenerateRequest = {
  task: LLMTask;
  prompt?: string;
  content: LLMContentInput;
  output?: {
    format?: "markdown" | "text" | "json";
  };
  generation?: LLMGenerationOptions;
  transport?: LLMTransportOptions;
  metadata?: Record<string, unknown>;
  onProgress?: ProgressCb;
};

export type LLMChatRequest = {
  content: LLMContentInput;
  conversation: ConversationMessage[];
  generation?: LLMGenerationOptions;
  transport?: LLMTransportOptions;
  metadata?: Record<string, unknown>;
  onProgress?: ProgressCb;
};

type ResolvedSingleContent = {
  mode: "single";
  content: string;
  isBase64: boolean;
  warnings: string[];
};

type ResolvedMultiFileContent = {
  mode: "multi-file";
  files: PdfFileInfo[];
  warnings: string[];
};

type ResolvedContent = ResolvedSingleContent | ResolvedMultiFileContent;

type ResolvedProvider = {
  id: string;
  impl: ILlmProvider;
  endpoint?: LLMEndpoint;
};

type CodexRequestMetadata = {
  itemKey?: string;
  attachmentKey?: string;
  sourceSha256?: string;
  parentExecutionId?: string;
  role?: "sol" | "luna";
  model?: string;
  reasoningEffort?: string;
  codexContract?: Record<string, unknown>;
};

let generatedExecutionId = 0;

function createExecutionId(): string {
  generatedExecutionId += 1;
  return `codex-exec-${Date.now().toString(36)}-${generatedExecutionId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCodexRequestMetadata(
  metadata?: Record<string, unknown>,
): CodexRequestMetadata {
  const nested = asRecord(metadata?.codex) || metadata || {};
  const role =
    nested.role === "luna" || nested.codexRole === "luna"
      ? "luna"
      : nested.role === "sol" || nested.codexRole === "sol"
        ? "sol"
        : undefined;
  const readString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = nested[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const sourceSha256 = readString("sourceSha256");
  const codexContract = asRecord(nested.codexContract) || undefined;
  return {
    itemKey: readString("itemKey", "zoteroItemKey"),
    attachmentKey: readString("attachmentKey", "zoteroAttachmentKey"),
    sourceSha256:
      sourceSha256 && /^[a-f0-9]{64}$/i.test(sourceSha256)
        ? sourceSha256.toLowerCase()
        : undefined,
    parentExecutionId: readString("parentExecutionId"),
    role,
    model: readString("model", "codexModel"),
    reasoningEffort: readString("reasoningEffort", "codexReasoningEffort"),
    codexContract,
  };
}

class CodexTurnSemaphore {
  private active = false;
  private readonly waiters: Array<{
    signal?: LLMAbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    onAbort?: () => void;
  }> = [];

  async acquire(signal?: LLMAbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (!this.active && this.waiters.length === 0) {
      this.active = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
      } as (typeof this.waiters)[number];
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(createAbortError(signal));
        this.pump();
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private release(): void {
    if (!this.active) return;
    this.active = false;
    this.pump();
  }

  private pump(): void {
    if (this.active) return;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal?.aborted) {
        if (waiter.onAbort) {
          waiter.signal.removeEventListener?.("abort", waiter.onAbort);
        }
        waiter.reject(createAbortError(waiter.signal));
        continue;
      }
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort!);
      this.active = true;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.release();
      });
      return;
    }
  }
}

const codexTurnSemaphore = new CodexTurnSemaphore();

function codexContractPromptSuffix(contract?: Record<string, unknown>): string {
  if (!contract) return "";
  try {
    return `\n\n[Codex contract — follow this bounded task specification]\n${JSON.stringify(contract)}\n[End Codex contract]`;
  } catch {
    return "";
  }
}

function injectCodexContractIntoConversation(
  conversation: ConversationMessage[],
  contract?: Record<string, unknown>,
): ConversationMessage[] {
  const suffix = codexContractPromptSuffix(contract);
  if (!suffix) return conversation;
  return [
    ...conversation,
    {
      role: "system",
      content: suffix.trim(),
    },
  ];
}

function policyLabel(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") return "configured";
  return "unknown";
}

function logCodex(...args: Parameters<ZToolkit["log"]>): void {
  try {
    if (typeof ztoolkit !== "undefined") ztoolkit.log(...args);
  } catch {
    // Audit logging must never change Provider behavior.
  }
}

export class LLMApiCallError extends Error {
  public readonly suppressTaskRetry = true;
  public readonly endpointId: string;
  public readonly endpointName: string;
  public readonly providerId: string;
  public readonly originalError?: Error;

  constructor(endpoint: LLMEndpoint, error: Error) {
    super(error.message);
    this.name = "LLMApiCallError";
    this.endpointId = endpoint.id;
    this.endpointName = endpoint.name;
    this.providerId = endpoint.providerType;
    this.originalError = error;
    this.stack = error.stack || this.stack;
  }
}

export class LLMApiExhaustedError extends Error {
  public readonly suppressTaskRetry = true;
  public readonly attempts: number;
  public readonly lastError?: Error;
  public readonly endpointId?: string;
  public readonly endpointName?: string;
  public readonly providerId?: string;

  constructor(attempts: number, lastError?: Error) {
    super(lastError?.message || getString("llm-error-all-endpoints-failed"));
    this.name = "LLMApiExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
    const apiError = lastError as
      | {
          endpointId?: string;
          endpointName?: string;
          providerId?: string;
        }
      | undefined;
    this.endpointId = apiError?.endpointId;
    this.endpointName = apiError?.endpointName;
    this.providerId = apiError?.providerId;
    this.stack = lastError?.stack || this.stack;
  }
}

export class LLMService {
  private static readonly DEFAULT_AUTO_CONTINUATION_ROUNDS = 2;
  private static readonly MAX_AUTO_CONTINUATION_ROUNDS = 10;
  private static readonly CONTINUATION_TAIL_CHARS = 12000;
  private static readonly CONTINUATION_DEDUPE_LOOKBACK_CHARS = 4000;
  private static readonly CONTINUATION_MIN_OVERLAP_CHARS = 16;
  private static codexTaskLedger: CodexTaskLedger | null = null;

  /** Replace the ledger in focused tests without changing production routing. */
  static setCodexTaskLedger(ledger: CodexTaskLedger | null): void {
    this.codexTaskLedger = ledger;
  }

  static getCodexTaskLedger(): CodexTaskLedger {
    if (!this.codexTaskLedger) {
      this.codexTaskLedger = new CodexTaskLedger();
    }
    return this.codexTaskLedger;
  }

  static getRequestTimeout(): number {
    const raw = (getPref("requestTimeout") as string) || "300000";
    const val = parseInt(raw, 10) || 300000;
    return Math.max(val, 30000);
  }

  static getAutoContinuationRounds(): number {
    const raw =
      (getPref("autoContinuationRounds" as any) as string) ||
      String(this.DEFAULT_AUTO_CONTINUATION_ROUNDS);
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return this.DEFAULT_AUTO_CONTINUATION_ROUNDS;
    return Math.min(Math.max(parsed, 0), this.MAX_AUTO_CONTINUATION_ROUNDS);
  }

  static mapToKeyManagerId(providerId: string): ProviderId {
    const id = providerId.toLowerCase();
    if (id === "codex-app-server") return "codex-app-server";
    if (id.includes("gemini") || id === "google") return "google";
    if (id.includes("anthropic") || id.includes("claude")) return "anthropic";
    if (id === "openai-compat") return "openai-compat";
    if (id === "openrouter") return "openrouter";
    if (id === "volcanoark") return "volcanoark";
    if (id === "ollama") return "ollama";
    return "openai";
  }

  static resolveProvider(): ResolvedProvider {
    const endpoint = LLMEndpointManager.prepareRoute().endpoints[0];
    const providerId = endpoint.providerType;
    const impl =
      ProviderRegistry.get(providerId) || ProviderRegistry.get("openai");
    if (!impl) {
      const list = ProviderRegistry.list().join(", ");
      const msg = getString("llm-error-unknown-provider-with-list", {
        args: { provider: providerId, list },
      });
      this.notifyError(msg);
      throw new Error(msg);
    }
    return { id: providerId, impl, endpoint };
  }

  static getCurrentProvider(): ILlmProvider | null {
    try {
      return this.resolveProvider().impl;
    } catch {
      return null;
    }
  }

  static getProviderCapabilities(
    provider: ILlmProvider,
  ): LLMProviderCapabilities {
    if (provider.capabilities) return provider.capabilities;

    return {
      supportsText: true,
      supportsStreaming: true,
      supportsPdfBase64: true,
      maxPdfFiles:
        typeof provider.generateMultiFileSummary === "function" ? 8 : 1,
      supportsSystemPrompt: true,
      supportedParams: ["temperature", "topP", "maxTokens", "stream"],
    };
  }

  static getEffectivePdfProcessMode(endpoint?: LLMEndpoint): LLMPdfProcessMode {
    if (endpoint) {
      return LLMEndpointManager.getEffectivePdfProcessMode(endpoint);
    }

    try {
      const activeEndpoint = LLMEndpointManager.prepareRoute().endpoints[0];
      return LLMEndpointManager.getEffectivePdfProcessMode(activeEndpoint);
    } catch {
      return LLMEndpointManager.getGlobalPdfProcessMode();
    }
  }

  static buildOptions(
    providerId: string | LLMEndpoint,
    generation?: LLMGenerationOptions,
    transport?: LLMTransportOptions,
    extra?: Partial<LLMOptions>,
  ): LLMOptions {
    const endpoint = typeof providerId === "string" ? undefined : providerId;
    const id = (
      typeof providerId === "string" ? providerId : providerId.providerType
    ).toLowerCase();
    const enableTemperature = getPref("enableTemperature") ?? false;
    const enableMaxTokens = getPref("enableMaxTokens") ?? false;
    const enableTopP = getPref("enableTopP") ?? false;

    const common: LLMOptions = {
      stream: transport?.stream ?? getPref("stream") ?? true,
      requestTimeoutMs: transport?.timeoutMs ?? this.getRequestTimeout(),
      abortSignal: transport?.abortSignal,
      enablePromptCache:
        (getPref("enablePromptCacheOptimization" as any) as boolean) === true,
    };

    if (enableTemperature) {
      common.temperature =
        generation?.temperature ??
        (parseFloat((getPref("temperature") as string) || "0.7") || 0.7);
    }
    if (enableTopP) {
      common.topP =
        generation?.topP ??
        (parseFloat((getPref("topP") as string) || "1.0") || 1.0);
    }
    if (enableMaxTokens) {
      common.maxTokens =
        generation?.maxOutputTokens ??
        (parseInt((getPref("maxTokens") as string) || "81920", 10) || 81920);
    }
    const isCodexEndpoint = endpoint?.providerType === "codex-app-server";
    const reasoningEffort = resolveReasoningEffort(
      normalizeReasoningEffortSetting(
        generation?.reasoningEffort ??
          endpoint?.reasoningEffort ??
          getPref("reasoningEffort" as any),
        "default",
        { allowMax: isCodexEndpoint },
      ),
      { allowMax: isCodexEndpoint },
    );
    if (reasoningEffort) {
      common.reasoningEffort = reasoningEffort;
    }
    if (generation?.vendorOptions) {
      common.vendorOptions = generation.vendorOptions;
    }

    if (endpoint) {
      common.apiUrl = endpoint.apiUrl.trim();
      common.apiKey = endpoint.apiKey.trim();
      common.model = endpoint.model.trim();
      if (endpoint.providerType === "codex-app-server") {
        common.role = endpoint.codexRole;
        common.codexBinaryPath = endpoint.codexBinaryPath;
        common.approvalPolicy = endpoint.approvalPolicy;
        common.sandboxPolicy = endpoint.sandboxPolicy;
        common.networkAccess = endpoint.networkAccess;
        common.mcpEnabled = endpoint.mcpEnabled;
      }
    } else if (id.includes("gemini") || id === "google") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("geminiApiUrl") || "https://generativelanguage.googleapis.com"
      ).replace(/\/$/, "");
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (getPref("geminiModel") || "gemini-2.5-pro").trim();
    } else if (id.includes("anthropic") || id.includes("claude")) {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("anthropicApiUrl") || "https://api.anthropic.com"
      ).replace(/\/$/, "");
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("anthropicModel") || "claude-3-5-sonnet-20241022"
      ).trim();
    } else if (id === "openai-compat") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("openaiCompatApiUrl") ||
        "https://api.openai.com/v1/chat/completions"
      ).trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("openaiCompatModel") ||
        getPref("openaiApiModel") ||
        "gpt-3.5-turbo"
      ).trim();
    } else if (id === "openrouter") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("openRouterApiUrl") ||
        "https://openrouter.ai/api/v1/chat/completions"
      ).trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("openRouterModel") || "google/gemma-3-27b-it"
      ).trim();
    } else if (id === "volcanoark") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("volcanoArkApiUrl") ||
        "https://ark.cn-beijing.volces.com/api/v3/responses"
      ).trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("volcanoArkModel") || "doubao-seed-1-8-251228"
      ).trim();
    } else if (id === "ollama") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("ollamaApiUrl") || "http://localhost:11434"
      ).trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (getPref("ollamaModel") || "llama3.2").trim();
    } else {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (getPref("openaiApiUrl") || "").trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (getPref("openaiApiModel") || "gpt-3.5-turbo").trim();
    }

    return { ...common, ...(extra || {}) };
  }

  static getLLMOptions(): LLMOptions {
    const { id, endpoint } = this.resolveProvider();
    return this.buildOptions(endpoint || id);
  }

  private static isCodexEndpoint(endpoint: LLMEndpoint): boolean {
    return endpoint.providerType === "codex-app-server";
  }

  private static buildAttemptOptions(
    endpoint: LLMEndpoint,
    generation: LLMGenerationOptions | undefined,
    transport: LLMTransportOptions | undefined,
    metadata: Record<string, unknown> | undefined,
  ): { options: LLMOptions; context?: CodexExecutionContext } {
    const options = this.buildOptions(endpoint, generation, transport);
    if (!this.isCodexEndpoint(endpoint)) return { options };

    const requestMetadata = readCodexRequestMetadata(metadata);
    const role =
      requestMetadata.role || options.role || endpoint.codexRole || "sol";
    const roleModel = role === "luna" ? "gpt-5.6-luna" : "gpt-5.6-sol";
    const roleEffort = role === "luna" ? "max" : "high";
    const endpointModel = options.model || endpoint.model;
    const endpointRole = endpoint.codexRole || "sol";
    const shouldUseRoleDefaults =
      !!requestMetadata.role &&
      (!requestMetadata.model ||
        endpointModel === "gpt-5.6-sol" ||
        endpointModel === "gpt-5.6-luna" ||
        endpointRole !== role);
    options.role = role;
    options.model =
      requestMetadata.model ||
      (shouldUseRoleDefaults ? roleModel : endpointModel);
    options.reasoningEffort = (requestMetadata.reasoningEffort ||
      (shouldUseRoleDefaults
        ? roleEffort
        : options.reasoningEffort || roleEffort)) as any;
    options.executionId = createExecutionId();
    options.parentExecutionId = requestMetadata.parentExecutionId;
    options.codexSourceSha256 = requestMetadata.sourceSha256;
    options.codexContract = requestMetadata.codexContract;
    options.vendorOptions = {
      ...(options.vendorOptions || {}),
      codexAttempt: true,
    };
    const context: CodexExecutionContext = {
      executionId: options.executionId,
      parentExecutionId: options.parentExecutionId,
      role,
      model: options.model || roleModel,
      reasoningEffort: String(options.reasoningEffort || roleEffort),
      itemKey: requestMetadata.itemKey,
      attachmentKey: requestMetadata.attachmentKey,
      sourceSha256: requestMetadata.sourceSha256,
      approvalPolicy: policyLabel(options.approvalPolicy),
      sandboxPolicy: policyLabel(options.sandboxPolicy),
      networkAccess: options.networkAccess === true,
    };
    return { options, context };
  }

  private static async startCodexAttempt(
    options: LLMOptions,
    context: CodexExecutionContext | undefined,
    attempt: number,
  ): Promise<{ ledger: CodexTaskLedger; executionId: string } | null> {
    if (!context || !options.executionId) return null;
    const ledger = this.getCodexTaskLedger();
    try {
      await ledger.start(context, "running", { attempt });
      return { ledger, executionId: context.executionId };
    } catch (error) {
      logCodex("[AI-Butler] Codex execution ledger start failed:", error);
      return null;
    }
  }

  private static bindCodexTurnResult(
    options: LLMOptions,
    execution: { ledger: CodexTaskLedger; executionId: string } | null,
  ): void {
    if (!options.executionId) return;
    options.codexRequestId = options.executionId;
    options.onCodexTurnResult = async (result) => {
      options.codexThreadId = result.threadId;
      options.codexTurnId = result.turnId;
      options.codexDiagnostics = result.diagnostics;
      options.codexRequestId = result.requestId || options.executionId;
      if (!execution) return;
      try {
        await execution.ledger.update(execution.executionId, "running", {
          threadId: result.threadId,
          turnId: result.turnId,
          requestId: options.codexRequestId,
          diagnostics: result.diagnostics,
        });
      } catch (error) {
        logCodex("[AI-Butler] Codex execution ledger update failed:", error);
      }
    };
  }

  private static async completeCodexAttempt(
    options: LLMOptions,
    execution: { ledger: CodexTaskLedger; executionId: string } | null,
    status: "passed" | "failed",
    error?: unknown,
  ): Promise<void> {
    options.codexStatus = status;
    if (!execution) return;
    try {
      if (status === "passed") {
        await execution.ledger.complete(execution.executionId, {
          threadId: options.codexThreadId,
          turnId: options.codexTurnId,
          requestId: options.codexRequestId,
          diagnostics: options.codexDiagnostics,
          outputSummary: "Codex text response received",
        });
      } else {
        await execution.ledger.fail(execution.executionId, error, {
          threadId: options.codexThreadId,
          turnId: options.codexTurnId,
          requestId: options.codexRequestId,
          diagnostics: options.codexDiagnostics,
        });
      }
    } catch (ledgerError) {
      logCodex("[AI-Butler] Codex execution ledger close failed:", ledgerError);
    }
  }

  static async generate(request: LLMGenerateRequest): Promise<LLMResponse> {
    const prompt = request.prompt ?? this.getDefaultPrompt();
    return this.runGenerateWithEndpointRouting(request, prompt);
  }

  static async generateWithEndpoint(
    endpointId: string,
    request: LLMGenerateRequest,
  ): Promise<LLMResponse> {
    const endpoint = this.getRunnableEndpoint(endpointId);
    const prompt = request.prompt ?? this.getDefaultPrompt();
    return this.runGenerateWithFixedEndpoint(endpoint, request, prompt);
  }

  static async generateText(request: LLMGenerateRequest): Promise<string> {
    return (await this.generate(request)).text;
  }

  static async chat(request: LLMChatRequest): Promise<LLMResponse> {
    const route = LLMEndpointManager.prepareRoute();
    return this.chatWithEndpointRouting(request, route);
  }

  /**
   * 为一次多轮对话会话挑选并固定一个端点。
   *
   * `chat()` 每次调用都会重新执行端点路由。轮询策略下，游标随每个真实请求推进，
   * 会让同一篇论文的多轮精读被分发到不同端点，导致服务端上下文缓存按账号失效。
   * 本方法在会话开始时按当前路由策略选出端点，并仅推进一次游标；会话内后续轮次
   * 通过 `chatWithEndpoint()` 复用该端点。
   */
  static acquireChatSessionEndpoint(): LLMEndpoint {
    const route = LLMEndpointManager.prepareRoute();
    const endpoint = route.endpoints[0];
    LLMEndpointManager.markEndpointAttempted(endpoint.id);
    return endpoint;
  }

  static async chatWithEndpoint(
    endpointId: string,
    request: LLMChatRequest,
  ): Promise<LLMResponse> {
    const endpoint = this.getRunnableEndpoint(endpointId);
    return this.runChatWithFixedEndpoint(endpoint, request);
  }

  static async chatText(request: LLMChatRequest): Promise<string> {
    return (await this.chat(request)).text;
  }

  static async testConnection(): Promise<string> {
    const { id, impl, endpoint } = this.resolveProvider();
    const options = this.buildConnectionTestOptions(id, impl, endpoint);
    return this.callProviderWithCodexSlot(
      endpoint?.providerType === "codex-app-server",
      options,
      () => impl.testConnection(options),
    );
  }

  static async testConnectionWithKey(apiKey: string): Promise<string> {
    const { id, impl, endpoint } = this.resolveProvider();
    const options = this.buildConnectionTestOptions(id, impl, endpoint);
    options.apiKey = apiKey;
    return this.callProviderWithCodexSlot(
      endpoint?.providerType === "codex-app-server",
      options,
      () => impl.testConnection(options),
    );
  }

  static async listModels(
    providerId?: string,
    optionsOverride?: Partial<LLMOptions>,
  ): Promise<LLMModelInfo[]> {
    const id = ((providerId || getPref("provider") || "openai") as string)
      .trim()
      .toLowerCase();
    const impl = ProviderRegistry.get(id) || ProviderRegistry.get("openai");
    if (!impl) {
      throw new Error(
        getString("llm-error-unknown-provider", { args: { provider: id } }),
      );
    }
    if (typeof impl.listModels !== "function") {
      throw new Error(
        getString("llm-error-model-list-unsupported", {
          args: { provider: id },
        }),
      );
    }

    const options = this.buildOptions(
      id,
      undefined,
      { stream: false },
      {
        ...(optionsOverride || {}),
      },
    );
    return impl.listModels(options);
  }

  static async testEndpointConnection(endpoint: LLMEndpoint): Promise<string> {
    const provider = this.getProviderForEndpoint(endpoint);
    const options = this.buildConnectionTestOptions(
      endpoint.providerType,
      provider,
      endpoint,
    );
    return this.callProviderWithCodexSlot(
      endpoint.providerType === "codex-app-server",
      options,
      () => provider.testConnection(options),
    );
  }

  static endpointSupportsMultiFile(endpoint: LLMEndpoint): boolean {
    const provider = this.getProviderForEndpoint(endpoint);
    return (
      this.getProviderCapabilities(provider).maxPdfFiles > 1 &&
      typeof provider.generateMultiFileSummary === "function"
    );
  }

  static endpointSupportsPdfBase64(endpoint: LLMEndpoint): boolean {
    const provider = this.getProviderForEndpoint(endpoint);
    return this.getProviderCapabilities(provider).supportsPdfBase64;
  }

  private static getRunnableEndpoint(endpointId: string): LLMEndpoint {
    const endpoint = LLMEndpointManager.getEndpoint(endpointId);
    if (!endpoint) {
      throw new Error(
        getString("llm-error-endpoint-not-found", { args: { endpointId } }),
      );
    }
    if (!endpoint.enabled) {
      throw new Error(
        getString("llm-error-endpoint-disabled", {
          args: { endpoint: endpoint.name },
        }),
      );
    }
    return endpoint;
  }

  private static getProviderForEndpoint(endpoint: LLMEndpoint): ILlmProvider {
    const provider = ProviderRegistry.get(endpoint.providerType);
    if (!provider) {
      const list = ProviderRegistry.list().join(", ");
      throw new Error(
        getString("llm-error-unknown-provider-type", {
          args: {
            endpoint: endpoint.name,
            provider: endpoint.providerType,
            available: list,
          },
        }),
      );
    }
    return provider;
  }

  private static buildContinuationPrompt(originalPrompt: string): string {
    const trimmed = (originalPrompt || "").trim();
    return [
      "The previous assistant response was cut off because it reached the output token limit.",
      "Continue exactly from where the previous response stopped.",
      "Do not repeat any content that has already been written. Do not add greetings, explanations, or a new title.",
      trimmed
        ? `Original task for context only; keep following it while continuing: ${trimmed}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private static tailForContinuation(text: string): string {
    if (text.length <= this.CONTINUATION_TAIL_CHARS) return text;
    return text.slice(-this.CONTINUATION_TAIL_CHARS);
  }

  private static appendAutoContinuationWarning(
    warnings: string[],
    rounds: number,
    stillTruncated: boolean,
  ): void {
    if (rounds > 0) {
      warnings.push(
        getString("llm-warning-auto-continuation-used", {
          args: { count: rounds },
        }),
      );
    }
    if (stillTruncated) {
      warnings.push(
        rounds > 0
          ? getString("llm-warning-auto-continuation-still-truncated", {
              args: { count: rounds },
            })
          : getString("llm-warning-auto-continuation-disabled"),
      );
    }
  }

  private static async callProviderAndTrackTruncation(
    options: LLMOptions,
    call: () => Promise<string>,
  ): Promise<string> {
    resetTruncationState(options);
    return this.callProviderWithCodexSlot(
      Boolean(options.executionId),
      options,
      call,
    );
  }

  private static async callProviderWithCodexSlot(
    shouldSerialize: boolean,
    options: LLMOptions,
    call: () => Promise<string>,
  ): Promise<string> {
    const release = shouldSerialize
      ? await codexTurnSemaphore.acquire(options.abortSignal)
      : undefined;
    try {
      throwIfAborted(options.abortSignal);
      return await call();
    } finally {
      release?.();
    }
  }

  private static removeContinuationOverlap(
    previousText: string,
    continuation: string,
  ): string {
    if (!previousText || !continuation) return continuation;
    const previousTail = previousText.slice(
      -this.CONTINUATION_DEDUPE_LOOKBACK_CHARS,
    );
    const maxOverlap = Math.min(previousTail.length, continuation.length);
    for (
      let length = maxOverlap;
      length >= this.CONTINUATION_MIN_OVERLAP_CHARS;
      length--
    ) {
      if (previousTail.slice(-length) === continuation.slice(0, length)) {
        return continuation.slice(length);
      }
    }
    return continuation;
  }

  private static async autoContinueSingleContent(
    provider: ILlmProvider,
    pdfContent: string,
    isBase64: boolean,
    initialConversation: ConversationMessage[],
    initialText: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<{ text: string; rounds: number; stillTruncated: boolean }> {
    let text = "";
    let rounds = 0;
    const maxRounds = this.getAutoContinuationRounds();
    while (
      rounds < maxRounds &&
      isAutoContinuableTruncation(options.truncation)
    ) {
      throwIfAborted(options.abortSignal);
      rounds += 1;
      const conversation: ConversationMessage[] = [
        ...initialConversation,
        {
          role: "assistant",
          content: this.tailForContinuation(initialText + text),
        },
        {
          role: "user",
          content: this.buildContinuationPrompt(
            initialConversation[0]?.content || "",
          ),
        },
      ];
      const continuation = await this.callProviderAndTrackTruncation(
        options,
        () =>
          provider.chat(
            pdfContent,
            isBase64,
            conversation,
            options,
            onProgress,
          ),
      );
      text += this.removeContinuationOverlap(initialText + text, continuation);
    }
    return {
      text,
      rounds,
      stillTruncated: isAutoContinuableTruncation(options.truncation),
    };
  }

  private static async autoContinueSummaryText(
    provider: ILlmProvider,
    pdfContent: string,
    isBase64: boolean,
    prompt: string,
    initialText: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<{ text: string; rounds: number; stillTruncated: boolean }> {
    const initialConversation: ConversationMessage[] = [
      { role: "user", content: prompt || "" },
    ];
    const continued = await this.autoContinueSingleContent(
      provider,
      pdfContent,
      isBase64,
      initialConversation,
      initialText,
      options,
      onProgress,
    );
    return {
      text: initialText + continued.text,
      rounds: continued.rounds,
      stillTruncated: continued.stillTruncated,
    };
  }

  private static async autoContinueChatText(
    provider: ILlmProvider,
    pdfContent: string,
    isBase64: boolean,
    conversation: ConversationMessage[],
    initialText: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<{ text: string; rounds: number; stillTruncated: boolean }> {
    const baseConversation =
      conversation && conversation.length > 0
        ? conversation
        : [{ role: "user", content: "" } as ConversationMessage];
    const continued = await this.autoContinueSingleContent(
      provider,
      pdfContent,
      isBase64,
      baseConversation,
      initialText,
      options,
      onProgress,
    );
    return {
      text: initialText + continued.text,
      rounds: continued.rounds,
      stillTruncated: continued.stillTruncated,
    };
  }

  private static async autoContinueMultiFileSummary(
    provider: ILlmProvider,
    files: PdfFileInfo[],
    prompt: string,
    initialText: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<{ text: string; rounds: number; stillTruncated: boolean }> {
    if (typeof provider.generateMultiFileSummary !== "function") {
      return {
        text: initialText,
        rounds: 0,
        stillTruncated: isAutoContinuableTruncation(options.truncation),
      };
    }
    let text = initialText;
    let rounds = 0;
    const maxRounds = this.getAutoContinuationRounds();
    while (
      rounds < maxRounds &&
      isAutoContinuableTruncation(options.truncation)
    ) {
      throwIfAborted(options.abortSignal);
      rounds += 1;
      const continuationPrompt = `${this.buildContinuationPrompt(prompt)}\n\nPrevious response tail:\n${this.tailForContinuation(text)}`;
      const continuation = await this.callProviderAndTrackTruncation(
        options,
        () =>
          provider.generateMultiFileSummary!(
            files,
            continuationPrompt,
            options,
            onProgress,
          ),
      );
      text += this.removeContinuationOverlap(text, continuation);
    }
    return {
      text,
      rounds,
      stillTruncated: isAutoContinuableTruncation(options.truncation),
    };
  }

  private static async runGenerateWithEndpointRouting(
    request: LLMGenerateRequest,
    prompt: string,
  ): Promise<LLMResponse> {
    const route = LLMEndpointManager.prepareRoute();
    const useRetry = request.transport?.retry ?? true;
    const maxRetries = useRetry ? route.maxAttempts : 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      throwIfAborted(request.transport?.abortSignal);
      const endpoint = route.endpoints[attempt % route.endpoints.length];
      try {
        const response = await this.generateOnceWithEndpoint(
          endpoint,
          request,
          prompt,
          attempt,
        );
        LLMEndpointManager.markEndpointAttempted(endpoint.id);
        return response;
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        LLMEndpointManager.markEndpointAttempted(endpoint.id);
        lastError = error instanceof Error ? error : new Error(String(error));
        ztoolkit.log(
          `[LLMService] API failed via ${endpoint.name} (${attempt + 1}/${maxRetries}): ${lastError.message}`,
        );
      }
    }

    throw new LLMApiExhaustedError(maxRetries, lastError || undefined);
  }

  private static async generateOnceWithEndpoint(
    endpoint: LLMEndpoint,
    request: LLMGenerateRequest,
    prompt: string,
    attempt = 0,
  ): Promise<LLMResponse> {
    const { options, context } = this.buildAttemptOptions(
      endpoint,
      request.generation,
      request.transport,
      request.metadata,
    );
    const execution = await this.startCodexAttempt(options, context, attempt);
    this.bindCodexTurnResult(options, execution);
    try {
      const response = await this.generateOnceWithEndpointBody(
        endpoint,
        request,
        prompt,
        options,
      );
      await this.completeCodexAttempt(options, execution, "passed");
      return response;
    } catch (error) {
      await this.completeCodexAttempt(options, execution, "failed", error);
      throw error;
    }
  }

  private static async generateOnceWithEndpointBody(
    endpoint: LLMEndpoint,
    request: LLMGenerateRequest,
    prompt: string,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    if (
      endpoint.providerType === "codex-app-server" &&
      request.task === "image-summary"
    ) {
      throw new Error("codex-image-summary-unsupported");
    }
    const provider = this.getProviderForEndpoint(endpoint);
    const providerPrompt =
      prompt +
      (endpoint.providerType === "codex-app-server"
        ? codexContractPromptSuffix(options.codexContract)
        : "");
    const warnings: string[] = [];
    request.transport?.onStatus?.({
      stage: "llm-preparing",
      label: getString("progress-llm-preparing"),
      message: getString("progress-llm-preparing-message"),
      progress: 40,
      endpointName: endpoint.name,
      model: endpoint.model,
      detail: getString("progress-llm-endpoint-detail", {
        args: { provider: endpoint.providerType, endpoint: endpoint.name },
      }),
    });
    throwIfAborted(request.transport?.abortSignal);
    const resolved = await this.resolveContent(
      provider,
      request.content,
      warnings,
      true,
      endpoint,
      request.transport?.onStatus
        ? (message, progress, meta) =>
            request.transport?.onStatus?.({
              ...(meta || {}),
              message,
              progress,
            })
        : undefined,
    );
    throwIfAborted(request.transport?.abortSignal);
    request.transport?.onStatus?.({
      stage: "llm-uploading",
      label: getString("progress-llm-uploading"),
      message: getString("progress-llm-uploading-message"),
      progress: 42,
      endpointName: endpoint.name,
      model: options.model || endpoint.model,
      detail: getString("progress-llm-endpoint-model-detail", {
        args: {
          provider: endpoint.providerType,
          endpoint: endpoint.name,
          model: options.model || endpoint.model || "unknown",
        },
      }),
    });
    let sawFirstChunk = false;
    const progressProxy: ProgressCb | undefined = request.onProgress
      ? async (chunk: string) => {
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            request.transport?.onStatus?.({
              stage: "llm-streaming",
              label: getString("progress-llm-streaming"),
              message: getString("progress-llm-streaming-message"),
              progress: 50,
              endpointName: endpoint.name,
              model: options.model || endpoint.model,
              detail: getString("progress-llm-first-chunk-detail"),
            });
          }
          await request.onProgress?.(chunk);
        }
      : undefined;
    request.transport?.onStatus?.({
      stage: "llm-waiting",
      label: getString("progress-llm-waiting"),
      message: getString("progress-llm-waiting-message"),
      progress: 45,
      endpointName: endpoint.name,
      model: options.model || endpoint.model,
      detail: getString("progress-llm-waiting-detail"),
    });
    let text: string;
    if (resolved.mode === "multi-file") {
      if (typeof provider.generateMultiFileSummary !== "function") {
        throw new Error(
          getString("llm-error-provider-multi-file-unsupported", {
            args: { provider: endpoint.providerType },
          }),
        );
      }
      try {
        text = await this.callProviderAndTrackTruncation(options, () =>
          provider.generateMultiFileSummary!(
            resolved.files,
            providerPrompt,
            options,
            progressProxy,
          ),
        );
        const continued = await this.autoContinueMultiFileSummary(
          provider,
          resolved.files,
          providerPrompt,
          text,
          options,
          progressProxy,
        );
        text = continued.text;
        this.appendAutoContinuationWarning(
          warnings,
          continued.rounds,
          continued.stillTruncated,
        );
      } catch (error: unknown) {
        if (isAbortError(error, options.abortSignal)) {
          throw normalizeAbortError(error, options.abortSignal);
        }
        throw this.toApiCallError(endpoint, error);
      }
    } else {
      try {
        text = await this.callProviderAndTrackTruncation(options, () =>
          provider.generateSummary(
            resolved.content,
            resolved.isBase64,
            providerPrompt,
            options,
            progressProxy,
          ),
        );
        const continued = await this.autoContinueSummaryText(
          provider,
          resolved.content,
          resolved.isBase64,
          providerPrompt,
          text,
          options,
          progressProxy,
        );
        text = continued.text;
        this.appendAutoContinuationWarning(
          warnings,
          continued.rounds,
          continued.stillTruncated,
        );
      } catch (error: unknown) {
        if (isAbortError(error, options.abortSignal)) {
          throw normalizeAbortError(error, options.abortSignal);
        }
        throw this.toApiCallError(endpoint, error);
      }
    }
    request.transport?.onStatus?.({
      stage: "llm-streaming",
      label: getString("progress-llm-complete"),
      message: getString("progress-llm-complete-message"),
      progress: 78,
      endpointName: endpoint.name,
      model: options.model || endpoint.model,
      detail: getString("progress-llm-complete-detail", {
        args: { count: text.length },
      }),
    });
    if (options.executionId) options.codexStatus = "passed";
    return this.toResponse(
      text,
      endpoint.providerType,
      endpoint,
      options,
      warnings,
    );
  }

  private static async runGenerateWithFixedEndpoint(
    endpoint: LLMEndpoint,
    request: LLMGenerateRequest,
    prompt: string,
  ): Promise<LLMResponse> {
    const useRetry = request.transport?.retry ?? true;
    const maxAttempts = useRetry ? LLMEndpointManager.getMaxAttemptCount() : 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfAborted(request.transport?.abortSignal);
      try {
        return await this.generateOnceWithEndpoint(
          endpoint,
          request,
          prompt,
          attempt,
        );
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        ztoolkit.log(
          `[LLMService] API failed via ${endpoint.name} (${attempt + 1}/${maxAttempts}): ${lastError.message}`,
        );
      }
    }

    throw new LLMApiExhaustedError(maxAttempts, lastError || undefined);
  }

  private static async chatWithEndpointRouting(
    request: LLMChatRequest,
    route: ReturnType<typeof LLMEndpointManager.prepareRoute>,
  ): Promise<LLMResponse> {
    const useRetry = request.transport?.retry ?? true;
    const maxRetries = useRetry ? route.maxAttempts : 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      throwIfAborted(request.transport?.abortSignal);
      const endpoint = route.endpoints[attempt % route.endpoints.length];
      try {
        const response = await this.chatOnceWithEndpoint(
          endpoint,
          request,
          attempt,
        );
        LLMEndpointManager.markEndpointAttempted(endpoint.id);
        return response;
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        LLMEndpointManager.markEndpointAttempted(endpoint.id);
        lastError = error instanceof Error ? error : new Error(String(error));
        ztoolkit.log(
          `[LLMService] Chat API failed via ${endpoint.name} (${attempt + 1}/${maxRetries}): ${lastError.message}`,
        );
      }
    }

    throw new LLMApiExhaustedError(maxRetries, lastError || undefined);
  }

  private static async chatOnceWithEndpoint(
    endpoint: LLMEndpoint,
    request: LLMChatRequest,
    attempt = 0,
  ): Promise<LLMResponse> {
    const { options, context } = this.buildAttemptOptions(
      endpoint,
      request.generation,
      request.transport,
      request.metadata,
    );
    const execution = await this.startCodexAttempt(options, context, attempt);
    this.bindCodexTurnResult(options, execution);
    try {
      const response = await this.chatOnceWithEndpointBody(
        endpoint,
        request,
        options,
      );
      await this.completeCodexAttempt(options, execution, "passed");
      return response;
    } catch (error) {
      await this.completeCodexAttempt(options, execution, "failed", error);
      throw error;
    }
  }

  private static async chatOnceWithEndpointBody(
    endpoint: LLMEndpoint,
    request: LLMChatRequest,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    const provider = this.getProviderForEndpoint(endpoint);
    const providerConversation =
      endpoint.providerType === "codex-app-server"
        ? injectCodexContractIntoConversation(
            request.conversation,
            options.codexContract,
          )
        : request.conversation;
    const warnings: string[] = [];
    request.transport?.onStatus?.({
      stage: "llm-preparing",
      label: getString("progress-llm-preparing"),
      message: getString("progress-llm-preparing-message"),
      progress: 40,
      endpointName: endpoint.name,
      model: endpoint.model,
      detail: getString("progress-llm-endpoint-detail", {
        args: { provider: endpoint.providerType, endpoint: endpoint.name },
      }),
    });
    throwIfAborted(request.transport?.abortSignal);
    const resolved = await this.resolveContent(
      provider,
      request.content,
      warnings,
      false,
      endpoint,
      request.transport?.onStatus
        ? (message, progress, meta) =>
            request.transport?.onStatus?.({
              ...(meta || {}),
              message,
              progress,
            })
        : undefined,
    );
    throwIfAborted(request.transport?.abortSignal);
    if (resolved.mode !== "single") {
      throw new Error(getString("llm-error-chat-multi-file-unsupported"));
    }
    request.transport?.onStatus?.({
      stage: "llm-uploading",
      label: getString("progress-llm-uploading"),
      message: getString("progress-llm-uploading-message"),
      progress: 42,
      endpointName: endpoint.name,
      model: options.model || endpoint.model,
      detail: getString("progress-llm-endpoint-model-detail", {
        args: {
          provider: endpoint.providerType,
          endpoint: endpoint.name,
          model: options.model || endpoint.model || "unknown",
        },
      }),
    });
    let sawFirstChunk = false;
    const progressProxy: ProgressCb | undefined = request.onProgress
      ? async (chunk: string) => {
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            request.transport?.onStatus?.({
              stage: "llm-streaming",
              label: getString("progress-llm-streaming"),
              message: getString("progress-llm-streaming-message"),
              progress: 50,
              endpointName: endpoint.name,
              model: options.model || endpoint.model,
              detail: getString("progress-llm-first-chunk-detail"),
            });
          }
          await request.onProgress?.(chunk);
        }
      : undefined;
    request.transport?.onStatus?.({
      stage: "llm-waiting",
      label: getString("progress-llm-waiting"),
      message: getString("progress-llm-waiting-message"),
      progress: 45,
      endpointName: endpoint.name,
      model: options.model || endpoint.model,
      detail: getString("progress-llm-waiting-detail"),
    });
    let text: string;
    try {
      text = await this.callProviderAndTrackTruncation(options, () =>
        provider.chat(
          resolved.content,
          resolved.isBase64,
          providerConversation,
          options,
          progressProxy,
        ),
      );
      const continued = await this.autoContinueChatText(
        provider,
        resolved.content,
        resolved.isBase64,
        providerConversation,
        text,
        options,
        progressProxy,
      );
      text = continued.text;
      this.appendAutoContinuationWarning(
        warnings,
        continued.rounds,
        continued.stillTruncated,
      );
    } catch (error: unknown) {
      if (isAbortError(error, options.abortSignal)) {
        throw normalizeAbortError(error, options.abortSignal);
      }
      throw this.toApiCallError(endpoint, error);
    }
    request.transport?.onStatus?.({
      stage: "llm-streaming",
      label: getString("progress-llm-complete"),
      message: getString("progress-llm-complete-message"),
      progress: 78,
      endpointName: endpoint.name,
      model: options.model || endpoint.model,
      detail: getString("progress-llm-complete-detail", {
        args: { count: text.length },
      }),
    });
    if (options.executionId) options.codexStatus = "passed";
    return this.toResponse(
      text,
      endpoint.providerType,
      endpoint,
      options,
      warnings,
    );
  }

  private static async runChatWithFixedEndpoint(
    endpoint: LLMEndpoint,
    request: LLMChatRequest,
  ): Promise<LLMResponse> {
    const useRetry = request.transport?.retry ?? true;
    const maxAttempts = useRetry ? LLMEndpointManager.getMaxAttemptCount() : 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfAborted(request.transport?.abortSignal);
      try {
        return await this.chatOnceWithEndpoint(endpoint, request, attempt);
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        ztoolkit.log(
          `[LLMService] Chat API failed via ${endpoint.name} (${attempt + 1}/${maxAttempts}): ${lastError.message}`,
        );
      }
    }

    throw new LLMApiExhaustedError(maxAttempts, lastError || undefined);
  }

  private static toApiCallError(
    endpoint: LLMEndpoint,
    error: unknown,
  ): LLMApiCallError {
    return new LLMApiCallError(
      endpoint,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private static async runWithRetry(
    providerId: string,
    provider: ILlmProvider,
    request: LLMGenerateRequest,
    resolved: ResolvedContent,
    prompt: string,
    warnings: string[],
  ): Promise<LLMResponse> {
    const keyManagerId = this.mapToKeyManagerId(providerId);
    const useRetry = request.transport?.retry ?? true;
    const useKeyRotation = request.transport?.keyRotation ?? true;
    const maxRetries = useRetry ? ApiKeyManager.getMaxSwitchCount() : 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      throwIfAborted(request.transport?.abortSignal);
      try {
        const options = this.buildOptions(
          providerId,
          request.generation,
          request.transport,
        );
        let text: string;
        if (resolved.mode === "multi-file") {
          if (typeof provider.generateMultiFileSummary !== "function") {
            throw new Error(
              getString("llm-error-multifile-unsupported", {
                args: { provider: providerId },
              }),
            );
          }
          text = await provider.generateMultiFileSummary(
            resolved.files,
            prompt,
            options,
            request.onProgress,
          );
        } else {
          text = await provider.generateSummary(
            resolved.content,
            resolved.isBase64,
            prompt,
            options,
            request.onProgress,
          );
        }
        if (useKeyRotation) ApiKeyManager.advanceToNextKey(keyManagerId);
        return this.toResponse(text, providerId, options, warnings);
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        ztoolkit.log(
          `[LLMService] API 调用失败 (尝试 ${attempt + 1}/${maxRetries}): ${lastError.message}`,
        );
        if (!useKeyRotation) break;
        const rotated = ApiKeyManager.rotateToNextKey(keyManagerId);
        if (!rotated) break;
      }
    }

    throw lastError || new Error(getString("llm-error-api-keys-exhausted"));
  }

  private static toResponse(
    text: string,
    providerId: string,
    endpointOrOptions: LLMEndpoint | LLMOptions,
    optionsOrWarnings: LLMOptions | string[],
    maybeWarnings?: string[],
  ): LLMResponse {
    const endpoint =
      "providerType" in endpointOrOptions ? endpointOrOptions : undefined;
    const options = endpoint
      ? (optionsOrWarnings as LLMOptions)
      : (endpointOrOptions as LLMOptions);
    const warnings = endpoint
      ? maybeWarnings || []
      : (optionsOrWarnings as string[]);
    const sanitizedText = sanitizeLLMOutputText(text);
    if (sanitizedText !== text) {
      ztoolkit.log(
        "[AI-Butler] Removed hidden reasoning block(s) from LLM output.",
      );
    }
    const codexMetadata = options.executionId
      ? {
          requestId: options.codexRequestId,
          executionId: options.executionId,
          parentExecutionId: options.parentExecutionId,
          role: options.role,
          threadId: options.codexThreadId,
          turnId: options.codexTurnId,
          diagnostics: options.codexDiagnostics,
          sourceSha256: options.codexSourceSha256,
          status: options.codexStatus,
          approvalPolicy:
            options.approvalPolicy === undefined
              ? undefined
              : policyLabel(options.approvalPolicy),
          sandboxPolicy:
            options.sandboxPolicy === undefined
              ? undefined
              : policyLabel(options.sandboxPolicy),
          networkAccess: options.networkAccess,
        }
      : {};
    return {
      text: sanitizedText,
      providerId,
      endpointId: endpoint?.id,
      providerName:
        endpoint?.name || LLMEndpointManager.providerLabel(providerId),
      model: options.model,
      generatedAt: new Date().toISOString(),
      warnings: warnings.length > 0 ? warnings : undefined,
      ...codexMetadata,
    };
  }

  private static async resolveContent(
    provider: ILlmProvider,
    input: LLMContentInput,
    warnings: string[],
    allowMultiFile: boolean,
    endpoint?: LLMEndpoint,
    statusCallback?: (
      message: string,
      progress: number,
      meta?: TaskProgressMeta,
    ) => void,
  ): Promise<ResolvedContent> {
    if (input.kind === "text") {
      if (
        endpoint?.providerType === "codex-app-server" &&
        input.policy === "pdf-base64"
      ) {
        throw new Error(getString("endpoint-pdf-unsupported"));
      }
      return { mode: "single", content: input.text, isBase64: false, warnings };
    }

    if (input.kind === "legacy") {
      if (
        endpoint?.providerType === "codex-app-server" &&
        (input.isBase64 || input.policy === "pdf-base64")
      ) {
        throw new Error(getString("endpoint-pdf-unsupported"));
      }
      return {
        mode: "single",
        content: input.isBase64
          ? input.content
          : this.normalizeText(input.content),
        isBase64: input.isBase64,
        warnings,
      };
    }

    const capabilities = this.getProviderCapabilities(provider);
    const policy = this.choosePolicy(input.policy, capabilities, endpoint);

    if (input.kind === "zotero-item") {
      return this.resolveZoteroItemContent(
        provider,
        input,
        policy,
        capabilities,
        warnings,
        allowMultiFile,
        statusCallback,
      );
    }

    if (input.kind === "pdf-attachment") {
      return this.resolvePdfAttachmentContent(
        input,
        policy,
        warnings,
        statusCallback,
      );
    }

    if (input.kind === "analyzable-attachment") {
      return this.resolveAnalyzableAttachmentContent(
        input,
        policy,
        warnings,
        statusCallback,
      );
    }

    return this.resolvePdfFilesContent(
      provider,
      input,
      policy,
      capabilities,
      warnings,
      allowMultiFile,
    );
  }

  private static choosePolicy(
    requestedPolicy: LLMContentPolicy | undefined,
    _capabilities: LLMProviderCapabilities,
    endpoint?: LLMEndpoint,
  ): LLMContentPolicy {
    const rawMode = (
      requestedPolicy || LLMEndpointManager.getEffectivePdfProcessMode(endpoint)
    )
      .trim()
      .toLowerCase();
    if (endpoint?.providerType === "codex-app-server") {
      if (rawMode === "pdf-base64") {
        throw new Error(getString("endpoint-pdf-unsupported"));
      }
      return rawMode === "mineru" ? "mineru" : "text";
    }
    let policy: LLMContentPolicy;
    if (rawMode === "text") policy = "text";
    else if (rawMode === "mineru") policy = "mineru";
    else if (rawMode === "auto") policy = "pdf-base64";
    else {
      policy = "pdf-base64";
    }

    return policy;
  }

  private static async resolveZoteroItemContent(
    provider: ILlmProvider,
    input: LLMZoteroItemContent,
    policy: LLMContentPolicy,
    capabilities: LLMProviderCapabilities,
    warnings: string[],
    allowMultiFile: boolean,
    statusCallback?: (
      message: string,
      progress: number,
      meta?: TaskProgressMeta,
    ) => void,
  ): Promise<ResolvedContent> {
    const attachmentMode =
      input.attachmentMode ||
      (getPref("pdfAttachmentMode") as string) ||
      "default";
    const maxAttachments = Math.max(input.maxAttachments || Infinity, 1);
    const pdfAttachments = await PDFExtractor.getAllPdfAttachments(input.item);
    const hasPdf = pdfAttachments.length > 0;

    if (!hasPdf) {
      const snapshotContent =
        await ContentExtractor.extractAnalyzableContentFromItem(
          input.item,
          false,
          policy === "mineru" ? "mineru" : "text",
          statusCallback,
        );
      if (snapshotContent.kind === "web-snapshot") {
        warnings.push(getString("llm-warning-web-snapshot-used"));
      }
      return {
        mode: "single",
        content: this.normalizeText(snapshotContent.content),
        isBase64: false,
        warnings,
      };
    }

    if (allowMultiFile && policy === "pdf-base64" && attachmentMode === "all") {
      if (pdfAttachments.length > 1) {
        if (
          capabilities.maxPdfFiles <= 1 ||
          typeof provider.generateMultiFileSummary !== "function"
        ) {
          throw new Error(getString("llm-error-multi-pdf-unsupported"));
        }

        const limit = Math.min(maxAttachments, capabilities.maxPdfFiles);
        const selected = pdfAttachments.slice(0, limit);
        if (pdfAttachments.length > selected.length) {
          warnings.push(
            getString("llm-warning-pdf-provider-limit", {
              args: { count: selected.length },
            }),
          );
        }
        const files = await Promise.all(
          selected.map(async (pdf, index) => {
            const filePath =
              await PDFExtractor.ensurePdfAttachmentAvailable(pdf);
            return {
              filePath: filePath || "",
              displayName:
                String(pdf.getField("title") || "").trim() ||
                "PDF-" + (index + 1),
              base64Content:
                await PDFExtractor.extractBase64FromAttachment(pdf),
            };
          }),
        );
        return { mode: "multi-file", files, warnings };
      }
    }

    if (policy === "pdf-base64") {
      const content = await PDFExtractor.extractBase64FromItem(
        input.item,
        statusCallback,
      );
      return { mode: "single", content, isBase64: true, warnings };
    }

    if (attachmentMode === "all") {
      const selected = pdfAttachments.slice(0, maxAttachments);
      const parts = await Promise.all(
        selected.map(async (pdf, index) => {
          const title =
            String(pdf.getField("title") || "").trim() || "PDF-" + (index + 1);
          const text = await PDFExtractor.extractTextFromAttachment(pdf);
          return "\n\n=== " + title + " ===\n" + this.normalizeText(text);
        }),
      );
      return {
        mode: "single",
        content: this.normalizeText(parts.join("\n")),
        isBase64: false,
        warnings,
      };
    }

    const text = await PDFExtractor.extractTextFromItem(
      input.item,
      policy,
      statusCallback,
    );
    return {
      mode: "single",
      content: this.normalizeText(text),
      isBase64: false,
      warnings,
    };
  }

  private static async resolvePdfAttachmentContent(
    input: LLMPdfAttachmentContent,
    policy: LLMContentPolicy,
    warnings: string[],
    statusCallback?: (
      message: string,
      progress: number,
      meta?: TaskProgressMeta,
    ) => void,
  ): Promise<ResolvedContent> {
    if (policy === "pdf-base64") {
      const content = await PDFExtractor.extractBase64FromAttachment(
        input.attachment,
      );
      return { mode: "single", content, isBase64: true, warnings };
    }

    const text =
      policy === "mineru" && input.item
        ? await PDFExtractor.extractTextFromItem(
            input.item,
            "mineru",
            statusCallback,
          )
        : await PDFExtractor.extractTextFromAttachment(input.attachment);
    return {
      mode: "single",
      content: this.normalizeText(text),
      isBase64: false,
      warnings,
    };
  }

  private static async resolveAnalyzableAttachmentContent(
    input: LLMAnalyzableAttachmentContent,
    policy: LLMContentPolicy,
    warnings: string[],
    statusCallback?: (
      message: string,
      progress: number,
      meta?: TaskProgressMeta,
    ) => void,
  ): Promise<ResolvedContent> {
    if (PDFExtractor.isPdfAttachment(input.attachment)) {
      return this.resolvePdfAttachmentContent(
        {
          kind: "pdf-attachment",
          item: input.item,
          attachment: input.attachment,
          policy: input.policy,
        },
        policy,
        warnings,
        statusCallback,
      );
    }

    if (policy === "pdf-base64") {
      warnings.push(getString("llm-warning-attachment-as-text"));
    }

    const text = await ContentExtractor.extractTextFromAnalyzableAttachment(
      input.attachment,
    );
    return {
      mode: "single",
      content: this.normalizeText(text),
      isBase64: false,
      warnings,
    };
  }

  private static resolvePdfFilesContent(
    provider: ILlmProvider,
    input: LLMPdfFilesContent,
    policy: LLMContentPolicy,
    capabilities: LLMProviderCapabilities,
    warnings: string[],
    allowMultiFile: boolean,
  ): ResolvedContent {
    if (
      allowMultiFile &&
      policy === "pdf-base64" &&
      capabilities.maxPdfFiles > 1 &&
      typeof provider.generateMultiFileSummary === "function"
    ) {
      const limit = Math.min(
        input.maxAttachments || Infinity,
        capabilities.maxPdfFiles,
      );
      const files = input.files.slice(0, limit);
      if (files.length < input.files.length) {
        warnings.push(
          getString("llm-warning-pdf-provider-limit", {
            args: { count: files.length },
          }),
        );
      }
      return { mode: "multi-file", files, warnings };
    }

    const first = input.files[0];
    if (!first) throw new Error(getString("llm-error-no-pdf-content"));

    if (
      policy === "pdf-base64" &&
      input.files.length > 1 &&
      (!allowMultiFile ||
        capabilities.maxPdfFiles <= 1 ||
        typeof provider.generateMultiFileSummary !== "function")
    ) {
      throw new Error(getString("llm-error-multi-pdf-unsupported"));
    }

    if (policy === "pdf-base64" && first.base64Content) {
      return {
        mode: "single",
        content: first.base64Content,
        isBase64: true,
        warnings,
      };
    }

    if (policy === "pdf-base64") {
      throw new Error(getString("llm-error-missing-uploadable-pdf"));
    }

    const textParts = input.files
      .map((file) =>
        file.textContent
          ? `\n\n=== ${file.displayName} ===\n${file.textContent}`
          : "",
      )
      .filter((part) => part.trim().length > 0);
    if (textParts.length === 0) {
      throw new Error(getString("llm-error-missing-text-or-pdf"));
    }

    return {
      mode: "single",
      content: this.normalizeText(textParts.join("\n")),
      isBase64: false,
      warnings,
    };
  }

  private static normalizeText(text: string): string {
    return PDFExtractor.truncateText(PDFExtractor.cleanText(text));
  }

  private static buildConnectionTestOptions(
    providerId: string,
    provider: ILlmProvider,
    endpoint?: LLMEndpoint,
  ): LLMOptions {
    const extra: Partial<LLMOptions> = {
      maxTokens: 16,
      vendorOptions: {
        connectionTestMode: this.getConnectionTestMode(provider, endpoint),
      },
    };
    if (endpoint?.providerType !== "codex-app-server") {
      extra.reasoningEffort = undefined;
    }
    return this.buildOptions(
      endpoint || providerId,
      undefined,
      { stream: false },
      extra,
    );
  }

  private static getConnectionTestMode(
    provider: ILlmProvider,
    endpoint?: LLMEndpoint,
  ): ConnectionTestMode {
    const policy = this.choosePolicy(
      undefined,
      this.getProviderCapabilities(provider),
      endpoint,
    );
    return policy === "pdf-base64" ? "pdf-base64" : "text";
  }

  private static getDefaultPrompt(): string {
    const saved = (getPref("summaryPrompt") as string) || "";
    return getConfiguredSummaryPrompt(saved);
  }

  private static notifyError(message: string): void {
    try {
      new ztoolkit.ProgressWindow("AI Butler", {
        closeOtherProgressWindows: false,
      })
        .createLine({ text: message, type: "default" })
        .show();
    } catch {
      try {
        Zotero.log(message);
      } catch {
        // 忽略通知失败
      }
    }
  }
}

export default LLMService;
