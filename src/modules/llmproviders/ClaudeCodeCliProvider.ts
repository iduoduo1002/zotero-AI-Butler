import { buildUserMessage, SYSTEM_ROLE_PROMPT } from "../../utils/prompts";
import { getString } from "../../utils/locale";
import { ProviderRegistry } from "./ProviderRegistry";
import type { ILlmProvider } from "./ILlmProvider";
import { createAbortError, throwIfAborted } from "./shared/requestAbort";
import { ClaudeCodeCliProcess } from "./claudeCodeCli/ClaudeCodeCliProcess";
import type {
  ClaudeCodeCliError,
  ClaudeCodeCliErrorCode,
  ClaudeCodeCliProcessFactory,
  ClaudeCodeCliProcessLike,
  ClaudeCodeCliProcessOptions,
} from "./claudeCodeCli/types";
import type {
  ConversationMessage,
  LLMOptions,
  LLMProviderCapabilities,
  ProgressCb,
} from "./types";

const DEFAULT_CLI_TIMEOUT_MS = 300_000;
const MAX_DIAGNOSTIC_LENGTH = 4000;

type JsonRecord = Record<string, unknown>;

type ParsedEvent = {
  delta?: string;
  finalText?: string;
  resultSeen?: boolean;
  errorMessage?: string;
  unsupportedOutput?: string;
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function createCliError(
  code: ClaudeCodeCliErrorCode,
  message: string,
  exitCode?: number,
): ClaudeCodeCliError {
  const error = new Error(message) as ClaudeCodeCliError;
  error.code = code;
  if (exitCode !== undefined) error.exitCode = exitCode;
  return error;
}

function unsupportedOptionError(detail: string): ClaudeCodeCliError {
  return createCliError(
    "claude-cli-invalid-options",
    `Claude Code CLI option is not supported: ${detail}`,
  );
}

function getPdfUnsupportedMessage(): string {
  try {
    return getString("endpoint-pdf-unsupported");
  } catch {
    return "Claude Code CLI accepts extracted text only; Base64 PDF input is unsupported";
  }
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

function normalizeStdinFrame(input: string): string {
  // Claude's `-p` stdin mode consumes plain UTF-8 text until EOF. Normalize
  // line endings and append one final LF; no JSON/session framing is sent.
  const normalized = input.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function getTimeoutMs(options: LLMOptions): number {
  const value = options.requestTimeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CLI_TIMEOUT_MS;
}

function getContentText(value: unknown): {
  text: string;
  unsupported?: string;
} {
  if (typeof value === "string") return { text: value };
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const record = asRecord(item);
      if (!record) {
        if (typeof item === "string") parts.push(item);
        continue;
      }
      const type = readString(record.type)?.toLowerCase();
      if (type === "text" || type === "text_delta") {
        const text = readString(record.text);
        if (text) parts.push(text);
        continue;
      }
      if (type) return { text: "", unsupported: type };
    }
    return { text: parts.join("") };
  }
  const record = asRecord(value);
  if (!record) return { text: "" };
  const type = readString(record.type)?.toLowerCase();
  if (type === "text" || type === "text_delta") {
    return { text: readString(record.text) || "" };
  }
  if (type) return { text: "", unsupported: type };
  return { text: readString(record.text) || "" };
}

function forbiddenEventType(type: string | undefined): boolean {
  if (!type) return false;
  const value = type.toLowerCase();
  return (
    value.includes("tool") ||
    value.includes("mcp") ||
    value.includes("command") ||
    value.includes("bash") ||
    value.includes("file_write") ||
    value.includes("write_file")
  );
}

function parseEvent(value: JsonRecord): ParsedEvent {
  const type = readString(value.type)?.toLowerCase();
  if (forbiddenEventType(type)) {
    return { unsupportedOutput: type || "unknown-tool-event" };
  }

  if (type === "result") {
    const subtype = readString(value.subtype)?.toLowerCase();
    const isError =
      value.is_error === true || Boolean(subtype?.includes("error"));
    const errorMessage =
      readString(value.error) ||
      (isError ? readString(value.result) : undefined) ||
      (isError ? subtype : undefined);
    if (isError) return { errorMessage: errorMessage || "CLI result failed" };
    const result = readString(value.result);
    return {
      finalText: result,
      resultSeen: true,
    };
  }

  if (type === "assistant") {
    const message = asRecord(value.message);
    const content = getContentText(message?.content ?? value.content);
    if (content.unsupported) return { unsupportedOutput: content.unsupported };
    const delta = getContentText(value.delta);
    if (delta.unsupported) return { unsupportedOutput: delta.unsupported };
    return { delta: delta.text || content.text };
  }

  if (type === "stream_event") {
    const event = asRecord(value.event);
    if (forbiddenEventType(readString(event?.type))) {
      return {
        unsupportedOutput: readString(event?.type) || "unknown-tool-event",
      };
    }
    const delta = asRecord(event?.delta);
    const content = getContentText(delta ?? event?.content ?? event?.text);
    if (content.unsupported) return { unsupportedOutput: content.unsupported };
    return { delta: content.text };
  }

  if (type === "content_block_delta") {
    const delta = getContentText(value.delta ?? value.content ?? value.text);
    if (delta.unsupported) return { unsupportedOutput: delta.unsupported };
    return { delta: delta.text };
  }

  // system/user metadata and other non-text stream records are ignored. The
  // CLI's result event remains the authoritative completion marker.
  return {};
}

function appendAssistantText(
  aggregate: string,
  next: string | undefined,
): { aggregate: string; delta: string } {
  if (!next) return { aggregate, delta: "" };
  if (next === aggregate) return { aggregate, delta: "" };
  if (aggregate && next.startsWith(aggregate)) {
    return { aggregate: next, delta: next.slice(aggregate.length) };
  }
  if (aggregate && aggregate.endsWith(next)) {
    return { aggregate, delta: "" };
  }
  return { aggregate: `${aggregate}${next}`, delta: next };
}

function redactText(value: string, redactions: readonly string[] = []): string {
  let safe = value;
  const unique = Array.from(
    new Set(redactions.filter((item) => typeof item === "string" && item)),
  ).sort((a, b) => b.length - a.length);
  for (const secret of unique) safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(^|[\s"'(])\/(?:[^\s"'`)]*)/g, "$1[PATH]")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[PATH]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-MAX_DIAGNOSTIC_LENGTH);
}

function readDiagnostics(
  process: ClaudeCodeCliProcessLike,
  redactions: readonly string[],
): string {
  try {
    return redactText(process.getDiagnostics?.(redactions) || "", redactions);
  } catch {
    return "";
  }
}

function isUnsupportedFlagDiagnostic(diagnostics: string): boolean {
  return /(?:unknown|unrecognized|invalid|unsupported).*(?:option|flag)|(?:option|flag).*(?:unknown|unrecognized|invalid|unsupported)/i.test(
    diagnostics,
  );
}

function safeAbortError(
  signal?: LLMOptions["abortSignal"],
): ClaudeCodeCliError {
  try {
    const error = createAbortError(signal) as ClaudeCodeCliError;
    error.message = "Claude Code CLI request aborted";
    error.code = "claude-cli-aborted";
    return error;
  } catch {
    const error = createCliError(
      "claude-cli-aborted",
      "Claude Code CLI request aborted",
    );
    error.name = "AbortError";
    return error;
  }
}

/** LLM Provider backed by one restricted local Claude Code CLI turn. */
export class ClaudeCodeCliProvider implements ILlmProvider {
  readonly id = "claude-code-cli";
  readonly capabilities: LLMProviderCapabilities = {
    supportsText: true,
    supportsStreaming: true,
    supportsPdfBase64: false,
    maxPdfFiles: 0,
    supportsSystemPrompt: true,
    supportedParams: ["stream"],
  };

  private readonly processFactory: ClaudeCodeCliProcessFactory;

  constructor(processFactory?: ClaudeCodeCliProcessFactory) {
    this.processFactory =
      processFactory || ((options) => ClaudeCodeCliProcess.spawn(options));
  }

  async generateSummary(
    content: string,
    isBase64: boolean,
    prompt: string | undefined,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    this.rejectBase64(isBase64);
    const input = buildSummaryInput(prompt, content);
    return this.runTextTurn(input, options, onProgress, [
      content,
      prompt || "",
    ]);
  }

  async chat(
    pdfContent: string,
    isBase64: boolean,
    conversation: ConversationMessage[],
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    this.rejectBase64(isBase64);
    const input = buildChatInput(pdfContent, conversation);
    return this.runTextTurn(input, options, onProgress, [
      pdfContent,
      ...conversation.map((message) => message.content),
    ]);
  }

  async testConnection(options: LLMOptions): Promise<string> {
    return this.runTextTurn("Say OK", options);
  }

  private rejectBase64(isBase64: boolean): void {
    if (isBase64) throw new Error(getPdfUnsupportedMessage());
  }

  private validateOptions(options: LLMOptions): void {
    if (options.mcpEnabled === true) {
      throw unsupportedOptionError("MCP is disabled for Claude Code CLI");
    }
    const vendorOptions = options.vendorOptions;
    if (
      vendorOptions &&
      (vendorOptions.mcpEnabled === true || vendorOptions.mcp === true)
    ) {
      throw unsupportedOptionError("MCP is disabled for Claude Code CLI");
    }
    if (options.claudeRestricted === false) {
      throw unsupportedOptionError("restricted mode cannot be disabled");
    }
    if (
      options.claudePermissionMode !== undefined &&
      options.claudePermissionMode !== "plan"
    ) {
      throw unsupportedOptionError("only plan permission mode is allowed");
    }
    if (
      options.claudeOutputFormat !== undefined &&
      options.claudeOutputFormat !== "stream-json"
    ) {
      throw unsupportedOptionError("only stream-json output is allowed");
    }
  }

  private async runTextTurn(
    input: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
    redactions: readonly string[] = [],
  ): Promise<string> {
    this.validateOptions(options);
    try {
      throwIfAborted(options.abortSignal);
    } catch {
      throw safeAbortError(options.abortSignal);
    }

    const processOptions: ClaudeCodeCliProcessOptions = {
      claudeBinaryPath: options.claudeBinaryPath,
      claudePermissionMode: options.claudePermissionMode,
      claudeRestricted: options.claudeRestricted,
      claudeOutputFormat: options.claudeOutputFormat,
    };
    const process = await this.processFactory(
      processOptions,
      options.abortSignal,
    );
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        await process.kill();
      } catch {
        // Preserve the original provider error; cleanup is best effort.
      }
    };

    try {
      return await this.consumeProcess(
        process,
        input,
        options,
        onProgress,
        stop,
        redactions,
      );
    } finally {
      await stop();
    }
  }

  private async consumeProcess(
    process: ClaudeCodeCliProcessLike,
    input: string,
    options: LLMOptions,
    onProgress: ProgressCb | undefined,
    stop: () => Promise<void>,
    redactions: readonly string[],
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let exitCode: number | undefined;
      let assistantText = "";
      let resultText: string | undefined;
      let resultSeen = false;
      let malformed = false;
      let lineQueue = Promise.resolve();
      const timer: { handle?: ReturnType<typeof setTimeout> } = {};
      let removeAbort: () => void = () => undefined;
      let removeLine: () => void = () => undefined;
      let removeExit: () => void = () => undefined;

      const diagnostics = () =>
        readDiagnostics(process, [input, ...redactions]);
      const cleanupListeners = () => {
        removeAbort();
        removeLine();
        removeExit();
        if (timer.handle !== undefined) clearTimeout(timer.handle);
      };
      const finish = (error?: Error, text?: string) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        if (error) reject(error);
        else resolve(text || "");
      };
      const fail = (error: ClaudeCodeCliError) => {
        finish(error);
        void stop();
      };
      const failFromExit = (code: number | undefined) => {
        const detail = diagnostics();
        if (code !== undefined && code !== 0) {
          if (isUnsupportedFlagDiagnostic(detail)) {
            fail(
              createCliError(
                "claude-cli-unsupported-flags",
                "Claude Code CLI does not support the required restricted flags; upgrade Claude Code CLI",
                code,
              ),
            );
          } else {
            fail(
              createCliError(
                "claude-cli-process-exit",
                `Claude Code CLI exited with code ${code}${detail ? `: ${detail}` : ""}`,
                code,
              ),
            );
          }
          return;
        }
        if (resultText?.trim()) {
          finish(undefined, resultText);
          return;
        }
        if (assistantText.trim() && resultSeen) {
          finish(undefined, assistantText);
          return;
        }
        if (malformed) {
          fail(
            createCliError(
              "claude-cli-malformed-response",
              `Claude Code CLI returned malformed stream-json${detail ? `: ${detail}` : ""}`,
            ),
          );
          return;
        }
        fail(
          createCliError(
            "claude-cli-empty-response",
            `Claude Code CLI returned no assistant text${detail ? `: ${detail}` : ""}`,
          ),
        );
      };

      const handleLine = async (line: string) => {
        if (settled) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          malformed = true;
          fail(
            createCliError(
              "claude-cli-malformed-response",
              "Claude Code CLI returned malformed stream-json",
            ),
          );
          return;
        }
        const record = asRecord(parsed);
        if (!record) {
          malformed = true;
          fail(
            createCliError(
              "claude-cli-malformed-response",
              "Claude Code CLI returned a non-object stream-json record",
            ),
          );
          return;
        }
        const event = parseEvent(record);
        if (event.unsupportedOutput) {
          fail(
            createCliError(
              "claude-cli-unsupported-output",
              `Claude Code CLI emitted unsupported output type: ${redactText(event.unsupportedOutput)}`,
            ),
          );
          return;
        }
        if (event.errorMessage) {
          const detail = diagnostics();
          fail(
            createCliError(
              "claude-cli-result-error",
              `Claude Code CLI result failed${event.errorMessage ? `: ${redactText(event.errorMessage, [input, ...redactions])}` : ""}${detail ? ` (${detail})` : ""}`,
              exitCode,
            ),
          );
          return;
        }
        if (event.resultSeen) {
          resultSeen = true;
          if (event.finalText !== undefined) resultText = event.finalText;
        }
        const appended = appendAssistantText(assistantText, event.delta);
        assistantText = appended.aggregate;
        if (appended.delta && onProgress) await onProgress(appended.delta);
        if (resultText?.trim() && !malformed) {
          finish(undefined, resultText);
        }
      };

      const onLine = (line: string) => {
        lineQueue = lineQueue.then(() => handleLine(line));
        void lineQueue.catch((error) => {
          fail(
            createCliError(
              "claude-cli-result-error",
              redactText(
                error instanceof Error ? error.message : String(error),
                [input, ...redactions],
              ),
            ),
          );
        });
      };
      const onExit = (code?: number) => {
        exitCode = code;
        void lineQueue.then(() => {
          if (!settled) failFromExit(code);
        });
      };

      const abortListener = () => {
        fail(safeAbortError(options.abortSignal));
      };

      const lineRemoval = process.onLine(onLine);
      if (typeof lineRemoval === "function") removeLine = lineRemoval;
      const exitRemoval = process.onExit(onExit);
      if (typeof exitRemoval === "function") removeExit = exitRemoval;
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          abortListener();
          return;
        }
        options.abortSignal.addEventListener?.("abort", abortListener, {
          once: true,
        });
        removeAbort = () =>
          options.abortSignal?.removeEventListener?.("abort", abortListener);
      }

      timer.handle = setTimeout(() => {
        if (settled) return;
        fail(
          createCliError(
            "claude-cli-timeout",
            "Claude Code CLI request timed out",
          ),
        );
      }, getTimeoutMs(options));

      void (async () => {
        try {
          await process.write(normalizeStdinFrame(input));
          await process.closeStdin?.();
        } catch (error) {
          if (options.abortSignal?.aborted) {
            fail(safeAbortError(options.abortSignal));
            return;
          }
          const detail = redactText(
            error instanceof Error ? error.message : String(error),
            [input, ...redactions],
          );
          fail(
            createCliError(
              "claude-cli-process-exit",
              `Claude Code CLI stdin failed${detail ? `: ${detail}` : ""}`,
              exitCode,
            ),
          );
        }
      })();
    });
  }
}

ProviderRegistry.register(new ClaudeCodeCliProvider());

export default ClaudeCodeCliProvider;
