import { buildUserMessage, SYSTEM_ROLE_PROMPT } from "../../utils/prompts";
import { ProviderRegistry } from "./ProviderRegistry";
import { CodexAppServerClient } from "./codexAppServer/CodexAppServerClient";
import { CodexAppServerProcess } from "./codexAppServer/CodexAppServerProcess";
import type {
  CodexAppServerEvent,
  CodexAppServerRunTurnParams,
} from "./codexAppServer/types";
import type { ILlmProvider } from "./ILlmProvider";
import type {
  ConversationMessage,
  LLMOptions,
  LLMProviderCapabilities,
  ProgressCb,
} from "./types";
import { getString } from "../../utils/locale";

export type CodexAppServerClientFactory = (
  options: LLMOptions,
) => CodexAppServerClient | Promise<CodexAppServerClient>;

let generatedExecutionId = 0;

function createExecutionId(options: LLMOptions): string {
  const configured = options.executionId?.trim();
  if (configured) return configured;
  generatedExecutionId += 1;
  return `zotero-ai-butler-${Date.now()}-${generatedExecutionId}`;
}

function resolveModel(options: LLMOptions): string {
  const configured = options.model?.trim();
  if (configured) return configured;
  return options.role === "luna" ? "gpt-5.6-luna" : "gpt-5.6-sol";
}

function resolveReasoningEffort(options: LLMOptions): string {
  const configured = String(options.reasoningEffort || "").trim();
  if (configured && configured !== "default") return configured;
  return options.role === "luna" ? "max" : "high";
}

function eventDelta(event: CodexAppServerEvent): string {
  if (event.method !== "item/agentMessage/delta") return "";
  const params = event.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  const record = params as Record<string, unknown>;
  const value = record.delta ?? record.text;
  return typeof value === "string" ? value : "";
}

function buildSummaryInput(
  prompt: string | undefined,
  content: string,
): string {
  return `${SYSTEM_ROLE_PROMPT}\n\n${buildUserMessage(prompt || "", content)}`;
}

function buildChatInput(
  pdfContent: string,
  conversation: ConversationMessage[],
): string {
  const messages = conversation.length
    ? conversation.map((message, index) => {
        const role = message.role.toUpperCase();
        const content =
          index === 0 && message.role === "user"
            ? buildUserMessage(message.content, pdfContent)
            : message.content;
        return `${role}:\n${content}`;
      })
    : [buildUserMessage("", pdfContent)];
  return `${SYSTEM_ROLE_PROMPT}\n\n${messages.join("\n\n")}`;
}

/** LLM Provider backed by the user's locally authenticated Codex CLI. */
export class CodexAppServerProvider implements ILlmProvider {
  readonly id = "codex-app-server";
  readonly capabilities: LLMProviderCapabilities = {
    supportsText: true,
    supportsStreaming: true,
    supportsPdfBase64: false,
    maxPdfFiles: 0,
    supportsSystemPrompt: true,
    supportedParams: ["stream", "reasoningEffort"],
  };

  private readonly clientFactory: CodexAppServerClientFactory;

  constructor(clientFactory?: CodexAppServerClientFactory) {
    this.clientFactory =
      clientFactory ||
      (async (options) => {
        const process = await CodexAppServerProcess.spawn({
          codexBinaryPath: options.codexBinaryPath,
        });
        return new CodexAppServerClient(process, {
          turnTimeoutMs: options.requestTimeoutMs,
        });
      });
  }

  async generateSummary(
    content: string,
    isBase64: boolean,
    prompt: string | undefined,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    this.rejectBase64(isBase64);
    return this.runTextTurn(
      buildSummaryInput(prompt, content),
      options,
      onProgress,
    );
  }

  async chat(
    pdfContent: string,
    isBase64: boolean,
    conversation: ConversationMessage[],
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    this.rejectBase64(isBase64);
    return this.runTextTurn(
      buildChatInput(pdfContent, conversation),
      options,
      onProgress,
    );
  }

  async testConnection(options: LLMOptions): Promise<string> {
    return this.runTextTurn("Say OK", {
      ...options,
      model: options.model?.trim() || "gpt-5.6-sol",
      reasoningEffort:
        options.reasoningEffort &&
        String(options.reasoningEffort).trim() !== "default"
          ? options.reasoningEffort
          : "high",
      executionId: createExecutionId(options),
    });
  }

  private rejectBase64(isBase64: boolean): void {
    if (isBase64) {
      let message = "pdf-base64-unsupported";
      try {
        message = getString("endpoint-pdf-unsupported");
      } catch {
        // Unit tests and early startup can run without the Zotero locale runtime.
      }
      throw new Error(message);
    }
  }

  private async runTextTurn(
    input: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    const client = await this.clientFactory(options);
    const params: CodexAppServerRunTurnParams = {
      model: resolveModel(options),
      reasoningEffort: resolveReasoningEffort(options),
      input,
      executionId: createExecutionId(options),
      parentExecutionId: options.parentExecutionId,
      role: options.role,
      threadId: options.codexThreadId,
      abortSignal: options.abortSignal,
      approvalPolicy: options.approvalPolicy,
      sandboxPolicy: options.sandboxPolicy,
      networkAccess: options.networkAccess,
      mcpEnabled: options.mcpEnabled,
      timeoutMs: options.requestTimeoutMs,
      onEvent: async (event) => {
        const delta = eventDelta(event);
        if (delta && onProgress) await onProgress(delta);
      },
    };

    try {
      const result = await client.runTurn(params);
      return result.text;
    } finally {
      client.close();
    }
  }
}

ProviderRegistry.register(new CodexAppServerProvider());

export default CodexAppServerProvider;
