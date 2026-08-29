import { ILlmProvider } from "./ILlmProvider";
import {
  APITestError,
  ConversationMessage,
  LLMOptions,
  LLMModelInfo,
  LLMProviderCapabilities,
  ProgressCb,
} from "./types";
import {
  getCodingPlanProfile,
  type CodingPlanProfile,
} from "../codingPlanProfiles";
import { getString } from "../../utils/locale";
import { SYSTEM_ROLE_PROMPT, buildUserMessage } from "../../utils/prompts";
import { getRequestTimeoutMs, logPromptCacheUsage } from "./shared/llmutils";
import {
  getConnectionTestInput,
  formatConnectionTestSuccess,
  formatProviderTimeout,
} from "./shared/connectionTest";
import {
  deriveVersionedModelsUrl,
  parseModelListResponse,
  requestModelListJson,
} from "./shared/modelList";
import { resolveReasoningEffort } from "./shared/reasoning";
import {
  bindAbortSignal,
  isAbortError,
  normalizeAbortError,
  throwIfAborted,
} from "./shared/requestAbort";
import { recordFinishReason } from "./shared/truncation";
import {
  providerHttpRequestFailed,
  providerMissingApiKey,
  providerMissingApiUrl,
  providerNoPdfFiles,
  providerNoPdfProcessed,
  providerRequestFailed,
  providerStreamMissingDone,
  providerStreamParseFailed,
  providerStreamTruncated,
  providerStreamUnexpectedEnd,
} from "./shared/localizedErrors";

type CodingPlanErrorKind =
  | "unauthorized"
  | "rate-limit"
  | "unsupported-parameter"
  | "timeout"
  | "malformed-response"
  | "request-failed"
  | "unsupported-input";

const REDACTED_VALUE = "[REDACTED]";
const REDACTED_REQUEST_BODY = REDACTED_VALUE;

function getHttpErrorResponse(error: any): {
  status?: number;
  responseBody: unknown;
  responseCode?: string;
  responseMessage?: string;
} {
  const status =
    typeof error?.xmlhttp?.status === "number"
      ? error.xmlhttp.status
      : typeof error?.details?.statusCode === "number"
        ? error.details.statusCode
        : undefined;
  const responseBody =
    error?.xmlhttp?.response ??
    error?.xmlhttp?.responseText ??
    error?.details?.responseBody ??
    "";
  let parsed: any;
  try {
    parsed =
      typeof responseBody === "string" && responseBody.trim()
        ? JSON.parse(responseBody)
        : responseBody;
  } catch {
    parsed = undefined;
  }
  const responseError = parsed?.error || parsed;
  return {
    status,
    responseBody,
    responseCode:
      typeof responseError?.code === "string"
        ? responseError.code
        : typeof responseError?.type === "string"
          ? responseError.type
          : typeof error?.details?.errorName === "string"
            ? error.details.errorName
            : undefined,
    responseMessage:
      typeof responseError?.message === "string"
        ? responseError.message
        : typeof error?.details?.errorMessage === "string"
          ? error.details.errorMessage
          : undefined,
  };
}

function codingPlanProfileForOptions(
  options: LLMOptions,
): CodingPlanProfile | undefined {
  const profile =
    getCodingPlanProfile(options.codingPlanProfile) ||
    getCodingPlanProfile(options.codingPlanVendor);
  return profile?.protocol === "openai-chat" ? profile : undefined;
}

function redactSensitiveText(value: unknown, apiKey?: string): string {
  let text =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  const secret = (apiKey || "").trim();
  if (secret) text = text.split(secret).join(REDACTED_VALUE);
  return text
    .replace(/(bearer\s+)[^\s,;]+/gi, `$1${REDACTED_VALUE}`)
    .replace(
      /([?&](?:api[_-]?key|authorization|token|secret|password)=)[^&#\s]+/gi,
      `$1${REDACTED_VALUE}`,
    )
    .replace(
      /((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*["']?)[^"',\s}&]+/gi,
      `$1${REDACTED_VALUE}`,
    );
}

function redactRequestUrl(url: string, apiKey?: string): string {
  return redactSensitiveText(url, apiKey);
}

function redactResponseHeaders(
  headers: Record<string, string>,
  apiKey?: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = /authorization|api[_-]?key|token|cookie|secret/i.test(name)
      ? REDACTED_VALUE
      : redactSensitiveText(value, apiKey);
  }
  return result;
}

function inferCodingPlanErrorKind(
  error: unknown,
  response: ReturnType<typeof getHttpErrorResponse>,
  fallback?: CodingPlanErrorKind,
): CodingPlanErrorKind {
  const status = response.status;
  const errorObject = error as any;
  const message = [
    errorObject?.message,
    response.responseCode,
    response.responseMessage,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    /(?:http\s*)?(?:401|403)\b|unauthor|forbidden|api.?key/.test(message)
  ) {
    return "unauthorized";
  }
  if (
    status === 429 ||
    /(?:http\s*)?429\b|rate.?limit|too many request|quota|限流|额度|频率过高/.test(
      message,
    )
  ) {
    return "rate-limit";
  }
  if (
    /unsupported|not supported|unknown parameter|invalid[_ -]?parameter|unsupported[_ -]?parameter|parameter.{0,20}(?:unsupported|invalid)|不支持|参数错误/.test(
      message,
    )
  ) {
    return "unsupported-parameter";
  }
  if (/timeout|timed out|超时/.test(message)) return "timeout";
  if (
    /malformed|parse|invalid[_ -]?json|invalid[_ -]?response|unexpected (?:end|token)|stream.*(?:trunc|missing|unexpected)|解析失败|格式错误|响应格式/.test(
      message,
    )
  ) {
    return "malformed-response";
  }
  return fallback || "request-failed";
}

function codingPlanErrorCode(
  profile: CodingPlanProfile,
  kind: CodingPlanErrorKind,
): string {
  return `coding-plan/${profile.id}/${kind}`;
}

/**
 * OpenAI 旧接口兼容 Provider（Chat Completions 格式）
 *
 * 使用 /v1/chat/completions 接口，适配第三方 API 服务商（例如 SiliconFlow 等）
 * 注意：如果使用 OpenAI 官方 API，请不要选择本接口，请改用 “OpenAI” 提供商（/v1/responses）。
 *
 * URL 要求：必须是完整的端点地址，例如：
 *   https://api.openai.com/v1/chat/completions
 * 不会在代码中自动追加路径。
 */
export class OpenAICompatProvider implements ILlmProvider {
  readonly id = "openai-compat"; // 供偏好使用的唯一标识
  readonly capabilities: LLMProviderCapabilities = {
    supportsText: true,
    supportsStreaming: true,
    supportsPdfBase64: true,
    maxPdfFiles: 20,
    supportsSystemPrompt: true,
    supportedParams: [
      "temperature",
      "topP",
      "maxTokens",
      "stream",
      "reasoningEffort",
    ],
  };

  private getCodingPlanProfile(
    options: LLMOptions,
  ): CodingPlanProfile | undefined {
    return codingPlanProfileForOptions(options);
  }

  private getModel(options: LLMOptions): string {
    const profile = this.getCodingPlanProfile(options);
    return (
      options.model?.trim() ||
      profile?.defaultModel ||
      "gpt-3.5-turbo"
    ).trim();
  }

  private normalizeCodingPlanError(
    error: unknown,
    options: LLMOptions,
    fallbackKind?: CodingPlanErrorKind,
  ): Error {
    const original =
      error instanceof Error ? error : new Error(String(error || "Error"));
    const profile = this.getCodingPlanProfile(options);
    if (!profile || isAbortError(original, options.abortSignal))
      return original;

    const response = getHttpErrorResponse(original);
    const kind = inferCodingPlanErrorKind(original, response, fallbackKind);
    const code = codingPlanErrorCode(profile, kind);
    const redactedMessage = redactSensitiveText(
      original.message,
      options.apiKey,
    );

    if (original instanceof APITestError && original.details) {
      original.details.errorName = code;
      original.details.errorMessage = redactedMessage;
      original.details.requestUrl = redactRequestUrl(
        original.details.requestUrl,
        options.apiKey,
      );
      original.details.requestBody = REDACTED_REQUEST_BODY;
      original.details.responseBody = redactSensitiveText(
        original.details.responseBody,
        options.apiKey,
      );
      if (original.details.responseHeaders) {
        original.details.responseHeaders = redactResponseHeaders(
          original.details.responseHeaders,
          options.apiKey,
        );
      }
      original.message = redactedMessage;
      (original as any).code = code;
      return original;
    }

    const normalized = new Error(redactedMessage, { cause: original });
    (normalized as any).code = code;
    return normalized;
  }

  private assertProfileTextInput(options: LLMOptions, isBase64: boolean): void {
    const profile = this.getCodingPlanProfile(options);
    if (profile && isBase64 && !profile.supportsPdfBase64) {
      const error = new Error(getString("endpoint-pdf-unsupported"));
      (error as any).code = codingPlanErrorCode(profile, "unsupported-input");
      throw error;
    }
  }

  private ensureUrlAndKey(options: LLMOptions) {
    const profile = this.getCodingPlanProfile(options);
    const configuredApiUrl = options.apiUrl?.trim() || "";
    const apiUrl = profile
      ? configuredApiUrl || profile.defaultApiUrl || ""
      : this.normalizeChatCompletionsUrl(
          configuredApiUrl || "https://api.openai.com/v1/chat/completions",
        );
    const apiKey = (options.apiKey || "").trim();
    if (!apiUrl) throw new Error(providerMissingApiUrl());
    if (!apiKey) throw new Error(providerMissingApiKey());
    return { apiUrl, apiKey };
  }

  private normalizeChatCompletionsUrl(apiUrl: string): string {
    const raw = apiUrl.trim().replace(/\/+$/, "");
    if (!raw) return raw;
    if (/\/(?:v\d+(?:beta)?\/)?chat\/completions$/i.test(raw)) return raw;
    if (/\/v\d+(?:beta)?$/i.test(raw)) return `${raw}/chat/completions`;
    if (/\/v\d+(?:beta)?\/.+$/i.test(raw)) {
      return raw.replace(/(\/v\d+(?:beta)?)(?:\/.*)?$/i, "$1/chat/completions");
    }
    return `${raw}/v1/chat/completions`;
  }

  private buildHeaders(apiKey: string) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    } as Record<string, string>;
  }

  private buildGenParams(options: LLMOptions) {
    const params: any = {};
    if (options.temperature !== undefined)
      params.temperature = options.temperature;
    if (options.topP !== undefined) params.top_p = options.topP;
    if (options.maxTokens !== undefined) params.max_tokens = options.maxTokens;
    const profile = this.getCodingPlanProfile(options);
    const model = this.getModel(options);
    const supportsReasoning =
      !profile ||
      (profile.id === "kimi-code" && /(?:^|[/_-])k3(?:[-_.]|$)/i.test(model));
    if (supportsReasoning) {
      const reasoningEffort = resolveReasoningEffort(options.reasoningEffort);
      if (reasoningEffort) params.reasoning_effort = reasoningEffort;
    }
    return params;
  }

  private buildPdfFilePart(base64Content: string, filename = "document.pdf") {
    const normalized = base64Content
      .trim()
      .replace(/^data:application\/pdf;base64,/i, "");
    const safeFilename = filename.trim() || "document.pdf";

    return {
      type: "file",
      file: {
        filename: /\.pdf$/i.test(safeFilename)
          ? safeFilename
          : `${safeFilename}.pdf`,
        file_data: `data:application/pdf;base64,${normalized}`,
      },
    };
  }

  async generateSummary(
    content: string,
    isBase64: boolean,
    prompt: string | undefined,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    this.assertProfileTextInput(options, isBase64);
    const { apiUrl, apiKey } = this.ensureUrlAndKey(options);
    const profile = this.getCodingPlanProfile(options);
    const model = this.getModel(options);
    const streamEnabled = options.stream ?? true;
    throwIfAborted(options.abortSignal);

    // Chat Completions 的消息结构
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: any;
    }> = [];
    messages.push({ role: "system", content: SYSTEM_ROLE_PROMPT });

    if (isBase64) {
      // Chat Completions 文件部件格式；PDF 用 application/pdf data URL。
      messages.push({
        role: "user",
        content: [
          { type: "text", text: prompt || "请分析这个文档。" },
          this.buildPdfFilePart(content, "paper.pdf"),
        ],
      });
    } else {
      const userText = buildUserMessage(prompt || "", content);
      messages.push({ role: "user", content: userText });
    }

    const basePayload: any = {
      model,
      messages,
      ...(profile ? { stream: streamEnabled } : {}),
      ...this.buildGenParams(options),
    };

    if (streamEnabled && onProgress) {
      const payload = { ...basePayload, stream: true };
      const chunks: string[] = [];
      let delivered = 0;
      let processedLength = 0;
      let partialLine = "";
      let streamComplete = false;
      let finishReason = "";
      let abortError: Error | null = null;
      let cleanupAbortSignal: (() => void) | undefined;

      try {
        await Zotero.HTTP.request("POST", apiUrl, {
          headers: this.buildHeaders(apiKey),
          body: JSON.stringify(payload),
          responseType: "text",
          timeout: options.requestTimeoutMs ?? getRequestTimeoutMs(),
          errorDelayMax: 0,
          requestObserver: (xmlhttp: XMLHttpRequest) => {
            cleanupAbortSignal = bindAbortSignal(
              options.abortSignal,
              xmlhttp,
              (error) => {
                abortError = error;
              },
            );
            xmlhttp.onprogress = (e: any) => {
              const status = e.target.status;
              if (status >= 400) {
                try {
                  const errorResponse = e.target.response;
                  const parsed = errorResponse
                    ? JSON.parse(errorResponse)
                    : null;
                  const err = parsed?.error || parsed || {};
                  const code = err?.code || `HTTP ${status}`;
                  const msg = err?.message || providerRequestFailed("API");
                  abortError = new Error(`${code}: ${msg}`);
                  xmlhttp.abort();
                } catch {
                  abortError = new Error(providerHttpRequestFailed(status));
                  xmlhttp.abort();
                }
                return;
              }

              try {
                const resp: string = e.target.response || "";
                if (resp.length > processedLength) {
                  const slice = partialLine + resp.slice(processedLength);
                  processedLength = resp.length;
                  const parts = slice.split(/\r?\n/);
                  partialLine =
                    parts[parts.length - 1].indexOf("data:") === 0 &&
                    slice.indexOf("\n", slice.length - 1) === slice.length - 1
                      ? ""
                      : parts.pop() || "";

                  for (const raw of parts) {
                    if (raw.indexOf("data:") !== 0) continue;
                    const jsonStr = raw.replace(/^data:\s*/, "").trim();
                    if (!jsonStr) continue;
                    if (jsonStr === "[DONE]") {
                      streamComplete = true;
                      continue;
                    }
                    try {
                      const evt = JSON.parse(jsonStr);
                      const reason = evt?.choices?.[0]?.finish_reason;
                      if (typeof reason === "string" && reason.length > 0) {
                        finishReason = reason;
                        streamComplete = true;
                        recordFinishReason(
                          options,
                          "openai-compat",
                          "choices.finish_reason",
                          reason,
                        );
                      }
                      const delta = evt?.choices?.[0]?.delta?.content;
                      if (typeof delta === "string" && delta.length > 0) {
                        chunks.push(delta);
                        const current = chunks.join("");
                        if (onProgress && current.length > delivered) {
                          const newChunk = current.slice(delivered);
                          delivered = current.length;
                          Promise.resolve(onProgress(newChunk)).catch((err) =>
                            ztoolkit.log(
                              "[AI-Butler] onProgress error (OpenAI Compat SSE):",
                              err,
                            ),
                          );
                        }
                      }
                    } catch {
                      abortError = new Error(
                        providerStreamParseFailed("OpenAI Compatible"),
                      );
                      xmlhttp.abort();
                      return;
                    }
                  }
                }
              } catch (err) {
                ztoolkit.log("[AI-Butler] OpenAI Compat SSE parse error:", err);
                if (!abortError) {
                  abortError = new Error(
                    providerStreamParseFailed("OpenAI Compatible"),
                  );
                }
                xmlhttp.abort();
              }
            };
            xmlhttp.onerror = () => {
              if (!abortError)
                abortError = new Error("NetworkError: XHR onerror");
            };
            xmlhttp.ontimeout = () => {
              if (!abortError)
                abortError = new Error(
                  formatProviderTimeout(
                    options.requestTimeoutMs ?? getRequestTimeoutMs(),
                  ),
                );
            };
          },
        });
      } catch (error: any) {
        if (abortError) {
          if (isAbortError(abortError, options.abortSignal)) {
            throw normalizeAbortError(abortError, options.abortSignal);
          }
          throw this.normalizeCodingPlanError(abortError, options);
        }
        if (isAbortError(error, options.abortSignal)) {
          throw normalizeAbortError(error, options.abortSignal);
        }
        let errorMessage =
          error?.message || providerRequestFailed("OpenAI Compatible");
        try {
          const responseText =
            error?.xmlhttp?.response || error?.xmlhttp?.responseText;
          if (responseText) {
            const parsed =
              typeof responseText === "string"
                ? JSON.parse(responseText)
                : responseText;
            const err = parsed?.error || parsed;
            const code = err?.code || "Error";
            const msg = err?.message || error?.message || String(error);
            errorMessage = `${code}: ${msg}`;
          }
        } catch {
          /* ignore */
        }
        throw this.normalizeCodingPlanError(
          new Error(errorMessage, { cause: error }),
          options,
        );
      } finally {
        cleanupAbortSignal?.();
      }

      try {
        this.assertStreamCompleted(streamComplete, finishReason, partialLine);
      } catch (error) {
        throw this.normalizeCodingPlanError(
          error,
          options,
          "malformed-response",
        );
      }
      return chunks.join("");
    }

    // 非流式
    let abortError: Error | null = null;
    let cleanupAbortSignal: (() => void) | undefined;
    try {
      const res = await Zotero.HTTP.request("POST", apiUrl, {
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(basePayload),
        responseType: "json",
        timeout: options.requestTimeoutMs ?? getRequestTimeoutMs(),
        errorDelayMax: 0,
        requestObserver: (xmlhttp: XMLHttpRequest) => {
          cleanupAbortSignal = bindAbortSignal(
            options.abortSignal,
            xmlhttp,
            (error) => {
              abortError = error;
            },
          );
        },
      });
      throwIfAborted(options.abortSignal);
      const data = res.response || res;
      if (
        profile &&
        (!data ||
          typeof data !== "object" ||
          !Array.isArray((data as any).choices) ||
          !(data as any).choices[0])
      ) {
        throw new Error(providerStreamParseFailed("OpenAI Compatible"));
      }
      recordFinishReason(
        options,
        "openai-compat",
        "choices.finish_reason",
        data?.choices?.[0]?.finish_reason,
      );
      const text = data?.choices?.[0]?.message?.content || "";
      const result = typeof text === "string" ? text : JSON.stringify(text);
      if (onProgress && result) await onProgress(result);
      return result;
    } catch (e: any) {
      if (abortError || isAbortError(e, options.abortSignal)) {
        throw normalizeAbortError(abortError || e, options.abortSignal);
      }
      let errorMessage =
        e?.message || providerRequestFailed("OpenAI Compatible");
      try {
        const responseText = e?.xmlhttp?.response || e?.xmlhttp?.responseText;
        if (responseText) {
          const parsed =
            typeof responseText === "string"
              ? JSON.parse(responseText)
              : responseText;
          const err = parsed?.error || parsed;
          const code = err?.code || "Error";
          const msg = err?.message || e?.message || String(e);
          errorMessage = `${code}: ${msg}`;
        }
      } catch {
        /* ignore */
      }
      throw this.normalizeCodingPlanError(
        new Error(errorMessage, { cause: e }),
        options,
      );
    } finally {
      cleanupAbortSignal?.();
    }
  }

  async chat(
    pdfContent: string,
    isBase64: boolean,
    conversation: ConversationMessage[],
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    this.assertProfileTextInput(options, isBase64);
    const { apiUrl, apiKey } = this.ensureUrlAndKey(options);
    const model = this.getModel(options);

    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: any;
    }> = [{ role: "system", content: SYSTEM_ROLE_PROMPT }];

    if (conversation && conversation.length > 0) {
      for (const msg of conversation) {
        let role: "system" | "user" | "assistant" = msg.role as any;
        if (role !== "system" && role !== "user" && role !== "assistant") {
          role = "user";
        }
        const isFirstUserMessage = role === "user" && msg === conversation[0];
        if (isFirstUserMessage) {
          // 第一条用户消息需要附带论文内容
          if (isBase64) {
            messages.push({
              role: "user",
              content: [
                { type: "text", text: msg.content },
                this.buildPdfFilePart(pdfContent, "paper.pdf"),
              ],
            });
          } else {
            // 文本模式：将论文内容附加到消息中
            messages.push({
              role: "user",
              content: buildUserMessage(msg.content, pdfContent),
            });
          }
        } else {
          messages.push({ role, content: msg.content });
        }
      }
    }

    const payload = {
      model,
      messages,
      stream: true,
      ...this.buildGenParams(options),
    } as any;

    const chunks: string[] = [];
    let delivered = 0;
    let processedLength = 0;
    let partialLine = "";
    let streamComplete = false;
    let finishReason = "";
    let lastUsage: any;
    let abortError: Error | null = null;
    let cleanupAbortSignal: (() => void) | undefined;

    try {
      await Zotero.HTTP.request("POST", apiUrl, {
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(payload),
        responseType: "text",
        timeout: options.requestTimeoutMs ?? getRequestTimeoutMs(),
        errorDelayMax: 0,
        requestObserver: (xmlhttp: XMLHttpRequest) => {
          cleanupAbortSignal = bindAbortSignal(
            options.abortSignal,
            xmlhttp,
            (error) => {
              abortError = error;
            },
          );
          xmlhttp.onprogress = (e: any) => {
            const status = e.target.status;
            if (status >= 400) {
              try {
                const errorResponse = e.target.response;
                const parsed = errorResponse ? JSON.parse(errorResponse) : null;
                const err = parsed?.error || parsed || {};
                const code = err?.code || `HTTP ${status}`;
                const msg = err?.message || providerRequestFailed("API");
                abortError = new Error(`${code}: ${msg}`);
                xmlhttp.abort();
              } catch {
                abortError = new Error(providerHttpRequestFailed(status));
                xmlhttp.abort();
              }
              return;
            }

            try {
              const resp: string = e.target.response || "";
              if (resp.length > processedLength) {
                const slice = partialLine + resp.slice(processedLength);
                processedLength = resp.length;
                const parts = slice.split(/\r?\n/);
                partialLine =
                  parts[parts.length - 1].indexOf("data:") === 0 &&
                  slice.indexOf("\n", slice.length - 1) === slice.length - 1
                    ? ""
                    : parts.pop() || "";

                for (const raw of parts) {
                  if (raw.indexOf("data:") !== 0) continue;
                  const jsonStr = raw.replace(/^data:\s*/, "").trim();
                  if (!jsonStr) continue;
                  if (jsonStr === "[DONE]") {
                    streamComplete = true;
                    continue;
                  }
                  try {
                    const evt = JSON.parse(jsonStr);
                    if (options.enablePromptCache && evt?.usage) {
                      lastUsage = evt.usage;
                    }
                    const reason = evt?.choices?.[0]?.finish_reason;
                    if (typeof reason === "string" && reason.length > 0) {
                      finishReason = reason;
                      streamComplete = true;
                      recordFinishReason(
                        options,
                        "openai-compat",
                        "choices.finish_reason",
                        reason,
                      );
                    }
                    const delta = evt?.choices?.[0]?.delta?.content;
                    if (typeof delta === "string" && delta.length > 0) {
                      chunks.push(delta);
                      const current = chunks.join("");
                      if (onProgress && current.length > delivered) {
                        const newChunk = current.slice(delivered);
                        delivered = current.length;
                        Promise.resolve(onProgress(newChunk)).catch((err) =>
                          ztoolkit.log(
                            "[AI-Butler] onProgress error (OpenAI Compat chat SSE):",
                            err,
                          ),
                        );
                      }
                    }
                  } catch {
                    abortError = new Error(
                      providerStreamParseFailed("OpenAI Compatible"),
                    );
                    xmlhttp.abort();
                    return;
                  }
                }
              }
            } catch (err) {
              ztoolkit.log(
                "[AI-Butler] OpenAI Compat chat SSE parse error:",
                err,
              );
              if (!abortError) {
                abortError = new Error(
                  providerStreamParseFailed("OpenAI Compatible"),
                );
              }
              xmlhttp.abort();
            }
          };
          xmlhttp.onerror = () => {
            if (!abortError)
              abortError = new Error("NetworkError: XHR onerror");
          };
          xmlhttp.ontimeout = () => {
            if (!abortError)
              abortError = new Error(
                formatProviderTimeout(
                  options.requestTimeoutMs ?? getRequestTimeoutMs(),
                ),
              );
          };
        },
      });
    } catch (error: any) {
      if (abortError) {
        if (isAbortError(abortError, options.abortSignal)) {
          throw normalizeAbortError(abortError, options.abortSignal);
        }
        throw this.normalizeCodingPlanError(abortError, options);
      }
      if (isAbortError(error, options.abortSignal)) {
        throw normalizeAbortError(error, options.abortSignal);
      }
      let errorMessage =
        error?.message || providerRequestFailed("OpenAI Compatible");
      try {
        const responseText =
          error?.xmlhttp?.response || error?.xmlhttp?.responseText;
        if (responseText) {
          const parsed =
            typeof responseText === "string"
              ? JSON.parse(responseText)
              : responseText;
          const err = parsed?.error || parsed;
          const code = err?.code || "Error";
          const msg = err?.message || error?.message || String(error);
          errorMessage = `${code}: ${msg}`;
        }
      } catch {
        /* ignore */
      }
      throw this.normalizeCodingPlanError(
        new Error(errorMessage, { cause: error }),
        options,
      );
    } finally {
      cleanupAbortSignal?.();
    }

    try {
      this.assertStreamCompleted(streamComplete, finishReason, partialLine);
    } catch (error) {
      throw this.normalizeCodingPlanError(error, options, "malformed-response");
    }
    if (options.enablePromptCache) {
      logPromptCacheUsage("OpenAI-Compat chat", lastUsage);
    }
    return chunks.join("");
  }

  private assertStreamCompleted(
    streamComplete: boolean,
    finishReason: string,
    partialLine: string,
  ): void {
    if (partialLine.trim()) {
      throw new Error(providerStreamTruncated("OpenAI Compatible"));
    }
    if (!streamComplete) {
      throw new Error(providerStreamMissingDone("OpenAI Compatible"));
    }
    if (finishReason && finishReason !== "stop" && finishReason !== "length") {
      throw new Error(
        providerStreamUnexpectedEnd("OpenAI Compatible", finishReason),
      );
    }
  }

  async listModels(options: LLMOptions): Promise<LLMModelInfo[]> {
    const { apiUrl, apiKey } = this.ensureUrlAndKey(options);
    const url = deriveVersionedModelsUrl(
      apiUrl,
      "https://api.openai.com/v1/chat/completions",
    );
    const data = await requestModelListJson(
      url,
      this.buildHeaders(apiKey),
      options.requestTimeoutMs ?? 30000,
    );
    return parseModelListResponse(data);
  }

  async testConnection(options: LLMOptions): Promise<string> {
    const { apiUrl, apiKey } = this.ensureUrlAndKey(options);
    const profile = this.getCodingPlanProfile(options);
    const model = this.getModel(options);
    const testInput = getConnectionTestInput(options);
    this.assertProfileTextInput(options, testInput.isBase64);
    const userContent = testInput.isBase64
      ? [
          { type: "text", text: testInput.text },
          this.buildPdfFilePart(
            testInput.pdfBase64 || "",
            "connection-test.pdf",
          ),
        ]
      : testInput.text;

    const payload = {
      model,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_ROLE_PROMPT },
        {
          role: "user",
          content: userContent,
        },
      ],
      ...this.buildGenParams(options),
    } as any;
    const payloadStr = JSON.stringify(payload, null, 2);

    let response: any;
    const responseHeaders: Record<string, string> = {};
    try {
      response = await Zotero.HTTP.request("POST", apiUrl, {
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(payload),
        errorDelayMax: 0,
        responseType: "text", // 使用 text 以获取原始响应
        timeout: options.requestTimeoutMs ?? 30000,
      });
      // 提取响应首部
      try {
        const headerStr = response.getAllResponseHeaders?.() || "";
        headerStr.split(/\r?\n/).forEach((line: string) => {
          const idx = line.indexOf(":");
          if (idx > 0) {
            responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line
              .slice(idx + 1)
              .trim();
          }
        });
      } catch {
        /* ignore */
      }
    } catch (error: any) {
      // 提取响应首部
      try {
        const headerStr = error?.xmlhttp?.getAllResponseHeaders?.() || "";
        headerStr.split(/\r?\n/).forEach((line: string) => {
          const idx = line.indexOf(":");
          if (idx > 0) {
            responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line
              .slice(idx + 1)
              .trim();
          }
        });
      } catch {
        /* ignore */
      }
      const status = error?.xmlhttp?.status;
      const responseBody =
        error?.xmlhttp?.response || error?.xmlhttp?.responseText || "";
      let errorMessage =
        error?.message || providerRequestFailed("OpenAI Compatible");
      let errorName = "NetworkError";
      try {
        if (responseBody) {
          const parsed =
            typeof responseBody === "string"
              ? JSON.parse(responseBody)
              : responseBody;
          const err = parsed?.error || parsed;
          errorName = err?.code || err?.type || "APIError";
          errorMessage = err?.message || errorMessage;
        }
      } catch {
        /* ignore */
      }

      const apiError = new APITestError(errorMessage, {
        errorName,
        errorMessage,
        statusCode: status,
        requestUrl: apiUrl,
        requestBody: payloadStr,
        responseHeaders,
        responseBody:
          typeof responseBody === "string"
            ? responseBody
            : JSON.stringify(responseBody),
      });
      throw this.normalizeCodingPlanError(apiError, options);
    }

    const status = response.status;
    const rawResponse = response.response || "";

    if (status === 200) {
      let json: any;
      try {
        json =
          typeof rawResponse === "string"
            ? JSON.parse(rawResponse)
            : rawResponse;
        if (
          profile &&
          (!json ||
            typeof json !== "object" ||
            !Array.isArray(json.choices) ||
            !json.choices[0])
        ) {
          throw new Error(providerStreamParseFailed("OpenAI Compatible"));
        }
      } catch (error) {
        throw this.normalizeCodingPlanError(
          error,
          options,
          "malformed-response",
        );
      }
      const content = json?.choices?.[0]?.message?.content || "";
      return formatConnectionTestSuccess({
        mode: testInput.mode,
        model,
        response: content,
        rawResponse,
      });
    }

    const apiError = new APITestError(`HTTP ${status}`, {
      errorName: `HTTP_${status}`,
      errorMessage: `HTTP ${status}: ${response.statusText || providerRequestFailed("API")}`,
      statusCode: status,
      requestUrl: apiUrl,
      requestBody: payloadStr,
      responseHeaders,
      responseBody: rawResponse,
    });
    throw this.normalizeCodingPlanError(apiError, options);
  }

  /**
   * 多文件摘要生成
   * 使用 OpenAI 兼容 Chat Completions 格式发送多个 PDF 文件
   */
  async generateMultiFileSummary(
    pdfFiles: Array<{
      filePath: string;
      displayName: string;
      base64Content?: string;
    }>,
    prompt: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    const { apiUrl, apiKey } = this.ensureUrlAndKey(options);
    const profile = this.getCodingPlanProfile(options);
    const model = this.getModel(options);
    throwIfAborted(options.abortSignal);

    if (pdfFiles.length === 0) throw new Error(providerNoPdfFiles());
    if (
      profile &&
      pdfFiles.some(
        (pdfFile) =>
          typeof pdfFile.base64Content === "string" &&
          pdfFile.base64Content.trim().length > 0,
      )
    ) {
      this.assertProfileTextInput(options, true);
    }

    // 构建 Chat Completions file 部分（使用 PDF data URI）
    const fileParts: any[] = [];
    for (let i = 0; i < pdfFiles.length; i++) {
      const pdfFile = pdfFiles[i];
      if (pdfFile.base64Content && pdfFile.base64Content.length > 0) {
        fileParts.push(
          this.buildPdfFilePart(
            pdfFile.base64Content,
            pdfFile.displayName || `document_${i + 1}.pdf`,
          ),
        );
        ztoolkit.log(
          `[AI-Butler] 添加 PDF 附件 (${i + 1}/${pdfFiles.length}): ${pdfFile.displayName}, base64 长度: ${pdfFile.base64Content.length}`,
        );
      } else {
        ztoolkit.log(
          `[AI-Butler] PDF 文件 ${pdfFile.displayName} 无 base64 内容，跳过`,
        );
      }
    }

    if (fileParts.length === 0) {
      throw new Error(providerNoPdfProcessed());
    }

    ztoolkit.log(
      `[AI-Butler] 准备发送 ${fileParts.length} 个 PDF 附件到 OpenAI 兼容接口`,
    );

    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: any;
    }> = [];
    messages.push({ role: "system", content: SYSTEM_ROLE_PROMPT });
    messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }, ...fileParts],
    });

    const payload = {
      model,
      messages,
      stream: true,
      ...this.buildGenParams(options),
    } as any;

    const chunks: string[] = [];
    let delivered = 0;
    let processedLength = 0;
    let partialLine = "";
    let gotAnyDelta = false;
    let abortError: Error | null = null;
    let cleanupAbortSignal: (() => void) | undefined;

    try {
      await Zotero.HTTP.request("POST", apiUrl, {
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(payload),
        responseType: "text",
        timeout: options.requestTimeoutMs ?? getRequestTimeoutMs(),
        errorDelayMax: 0,
        requestObserver: (xmlhttp: XMLHttpRequest) => {
          cleanupAbortSignal = bindAbortSignal(
            options.abortSignal,
            xmlhttp,
            (error) => {
              abortError = error;
            },
          );
          xmlhttp.onprogress = (e: any) => {
            const status = e.target.status;
            if (status >= 400) {
              try {
                const errorResponse = e.target.response;
                const parsed = errorResponse ? JSON.parse(errorResponse) : null;
                const err = parsed?.error || parsed || {};
                const code = err?.code || `HTTP ${status}`;
                const msg = err?.message || providerRequestFailed("API");
                abortError = new Error(`${code}: ${msg}`);
                xmlhttp.abort();
              } catch {
                abortError = new Error(providerHttpRequestFailed(status));
                xmlhttp.abort();
              }
              return;
            }

            try {
              const resp: string = e.target.response || "";
              if (resp.length > processedLength) {
                const slice = partialLine + resp.slice(processedLength);
                processedLength = resp.length;
                const parts = slice.split(/\r?\n/);
                partialLine =
                  parts[parts.length - 1].indexOf("data:") === 0 &&
                  slice.indexOf("\n", slice.length - 1) === slice.length - 1
                    ? ""
                    : parts.pop() || "";

                for (const raw of parts) {
                  if (raw.indexOf("data:") !== 0) continue;
                  const jsonStr = raw.replace(/^data:\s*/, "").trim();
                  if (!jsonStr || jsonStr === "[DONE]") continue;
                  try {
                    const evt = JSON.parse(jsonStr);
                    recordFinishReason(
                      options,
                      "openai-compat",
                      "choices.finish_reason",
                      evt?.choices?.[0]?.finish_reason,
                    );
                    const delta = evt?.choices?.[0]?.delta?.content;
                    if (typeof delta === "string" && delta.length > 0) {
                      gotAnyDelta = true;
                      chunks.push(delta);
                      const current = chunks.join("");
                      if (onProgress && current.length > delivered) {
                        const newChunk = current.slice(delivered);
                        delivered = current.length;
                        Promise.resolve(onProgress(newChunk)).catch((err) =>
                          ztoolkit.log(
                            "[AI-Butler] onProgress error (OpenAI Compat multi-PDF):",
                            err,
                          ),
                        );
                      }
                    }
                  } catch {
                    /* ignore */
                  }
                }
              }
            } catch (err) {
              ztoolkit.log(
                "[AI-Butler] OpenAI Compat multi-PDF SSE parse error:",
                err,
              );
            }
          };
          xmlhttp.onerror = () => {
            if (!abortError)
              abortError = new Error("NetworkError: XHR onerror");
          };
          xmlhttp.ontimeout = () => {
            if (!abortError)
              abortError = new Error(
                formatProviderTimeout(
                  options.requestTimeoutMs ?? getRequestTimeoutMs(),
                ),
              );
          };
        },
      });
    } catch (error: any) {
      if (abortError) {
        if (isAbortError(abortError, options.abortSignal)) {
          throw normalizeAbortError(abortError, options.abortSignal);
        }
        if (gotAnyDelta && chunks.length > 0) return chunks.join("");
        throw abortError;
      }
      if (isAbortError(error, options.abortSignal)) {
        throw normalizeAbortError(error, options.abortSignal);
      }
      let errorMessage =
        error?.message || providerRequestFailed("OpenAI Compatible");
      try {
        const responseText =
          error?.xmlhttp?.response || error?.xmlhttp?.responseText;
        if (responseText) {
          const parsed =
            typeof responseText === "string"
              ? JSON.parse(responseText)
              : responseText;
          const err = parsed?.error || parsed;
          const code = err?.code || "Error";
          const msg = err?.message || error?.message || String(error);
          errorMessage = `${code}: ${msg}`;
        }
      } catch {
        /* ignore */
      }
      if (gotAnyDelta && chunks.length > 0) return chunks.join("");
      throw new Error(errorMessage, { cause: error });
    } finally {
      cleanupAbortSignal?.();
    }

    const streamed = chunks.join("");
    if (gotAnyDelta && streamed) return streamed;
    return "";
  }
}

// 自注册
import { ProviderRegistry } from "./ProviderRegistry";
ProviderRegistry.register(new OpenAICompatProvider());

export default OpenAICompatProvider;
