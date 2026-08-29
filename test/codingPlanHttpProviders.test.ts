import { expect } from "chai";
import { LLMService } from "../src/modules/llmService";
import { OpenAICompatProvider } from "../src/modules/llmproviders/OpenAICompatProvider";
import { APITestError } from "../src/modules/llmproviders/types";
import type { LLMEndpoint } from "../src/modules/llmEndpointManager";
import { LLMEndpointManager } from "../src/modules/llmEndpointManager";
import type { LLMOptions } from "../src/modules/llmproviders/types";

const KIMI_URL = "https://api.kimi.com/coding/v1/chat/completions";
const GLM_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const SECRET = "profile-test-secret";

type RequestCapture = {
  method: string;
  url: string;
  options: {
    headers?: Record<string, string>;
    body?: string;
    responseType?: string;
    requestObserver?: (xhr: FakeXhr) => void;
  };
};

type FakeXhr = {
  status: number;
  statusText: string;
  response: unknown;
  responseText: unknown;
  aborted: boolean;
  onprogress?: (event: { target: FakeXhr }) => void;
  ontimeout?: () => void;
  onerror?: () => void;
  abort: () => void;
  getAllResponseHeaders?: () => string;
};

type MockResponse = {
  kind: "stream" | "json" | "error" | "timeout";
  body?: unknown;
  status?: number;
  statusText?: string;
  headers?: string;
  errorMessage?: string;
};

function makeFakeXhr(response: MockResponse): FakeXhr {
  const xhr: FakeXhr = {
    status: response.status ?? 200,
    statusText: response.statusText ?? "OK",
    response: response.body ?? "",
    responseText: response.body ?? "",
    aborted: false,
    abort() {
      xhr.aborted = true;
    },
    getAllResponseHeaders() {
      return response.headers || "";
    },
  };
  return xhr;
}

async function withMockedHttp<T>(
  response: MockResponse,
  run: (capture: RequestCapture) => Promise<T>,
): Promise<T> {
  const originalZotero = (globalThis as any).Zotero;
  let capture: RequestCapture | undefined;
  (globalThis as any).Zotero = {
    ...(originalZotero || {}),
    HTTP: {
      ...(originalZotero?.HTTP || {}),
      request: async (
        method: string,
        url: string,
        options: RequestCapture["options"],
      ) => {
        capture = { method, url, options };
        const xhr = makeFakeXhr(response);
        options.requestObserver?.(xhr);

        if (response.kind === "timeout") {
          xhr.ontimeout?.();
          throw Object.assign(
            new Error(response.errorMessage || "Request timeout"),
            { xmlhttp: xhr },
          );
        }

        if (response.kind === "stream") {
          xhr.response = response.body ?? "";
          xhr.responseText = response.body ?? "";
          xhr.onprogress?.({ target: xhr });
        }

        if (response.kind === "error" || xhr.aborted) {
          throw Object.assign(
            new Error(response.errorMessage || "HTTP request failed"),
            { xmlhttp: xhr },
          );
        }

        if (response.kind === "json") {
          return {
            status: xhr.status,
            statusText: xhr.statusText,
            response: response.body,
            getAllResponseHeaders: xhr.getAllResponseHeaders,
          };
        }
        return {
          status: xhr.status,
          statusText: xhr.statusText,
          response: response.body,
          getAllResponseHeaders: xhr.getAllResponseHeaders,
        };
      },
    },
  };

  try {
    return await run(
      new Proxy({} as RequestCapture, {
        get(_target, property: keyof RequestCapture) {
          return capture?.[property];
        },
      }),
    );
  } finally {
    if (originalZotero === undefined) delete (globalThis as any).Zotero;
    else (globalThis as any).Zotero = originalZotero;
  }
}

function getCapturedPayload(capture: RequestCapture): Record<string, any> {
  expect(capture.method).to.equal("POST");
  expect(capture.options.body).to.be.a("string");
  return JSON.parse(capture.options.body!);
}

function profileOptions(
  profile: "kimi-code" | "zhipu-glm-coding",
  overrides: Partial<LLMOptions> = {},
): LLMOptions {
  return {
    apiUrl: "",
    apiKey: SECRET,
    model: "",
    codingPlanVendor: profile,
    codingPlanProfile: profile,
    stream: false,
    ...overrides,
  };
}

function makeProfileEndpoint(
  profile: "kimi-code" | "zhipu-glm-coding",
  overrides: Partial<LLMEndpoint> = {},
): LLMEndpoint {
  const endpoint = LLMEndpointManager.createEndpoint("openai-compat");
  return {
    ...endpoint,
    apiUrl: "",
    apiKey: SECRET,
    model: "",
    codingPlanVendor: profile,
    codingPlanProfile: profile,
    ...overrides,
  };
}

async function expectRejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected promise to reject");
}

describe("Coding Plan OpenAI-compatible HTTP profiles", function () {
  it("fills empty profile endpoint URL and model while preserving explicit values", function () {
    const kimi = LLMService.buildOptions(makeProfileEndpoint("kimi-code"));
    expect(kimi.apiUrl).to.equal(KIMI_URL);
    expect(kimi.model).to.equal("kimi-for-coding");

    const explicit = LLMService.buildOptions(
      makeProfileEndpoint("zhipu-glm-coding", {
        apiUrl: "https://proxy.example.test/custom-chat",
        model: "glm-custom",
      }),
    );
    expect(explicit.apiUrl).to.equal("https://proxy.example.test/custom-chat");
    expect(explicit.model).to.equal("glm-custom");
  });

  it("streams Kimi text with the full endpoint, Bearer key, and Kimi defaults", async function () {
    const chunks: string[] = [];
    const provider = new OpenAICompatProvider();
    const options = profileOptions("kimi-code", {
      stream: true,
      reasoningEffort: "high",
      mcpEnabled: true,
      vendorOptions: {
        reasoning_effort: "xhigh",
        mcp: { enabled: true },
      },
    });

    const capture = await withMockedHttp(
      {
        kind: "stream",
        body:
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
      },
      async (request) => {
        const result = await provider.generateSummary(
          "正文",
          false,
          "请总结",
          options,
          (chunk) => {
            chunks.push(chunk);
          },
        );
        expect(result).to.equal("你好");
        return request;
      },
    );

    expect(capture.url).to.equal(KIMI_URL);
    expect(capture.options.headers).to.include({
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
    });
    const payload = getCapturedPayload(capture);
    expect(payload.model).to.equal("kimi-for-coding");
    expect(payload.stream).to.equal(true);
    expect(payload).to.not.have.property("reasoning_effort");
    expect(payload).to.not.have.property("mcpEnabled");
    expect(payload).to.not.have.property("mcp");
    expect(capture.options.body).to.not.contain(SECRET);
    expect(JSON.stringify(payload)).to.not.contain("base64");
    expect(chunks).to.deep.equal(["你", "好"]);
  });

  it("sends reasoning_effort only for a K3 Kimi model", async function () {
    const provider = new OpenAICompatProvider();
    const capture = await withMockedHttp(
      {
        kind: "json",
        body: {
          choices: [{ message: { content: "ok" } }],
        },
      },
      async (request) => {
        await provider.generateSummary(
          "正文",
          false,
          "请总结",
          profileOptions("kimi-code", {
            model: "k3-256k",
            reasoningEffort: "high",
          }),
        );
        return request;
      },
    );

    const payload = getCapturedPayload(capture);
    expect(payload.model).to.equal("k3-256k");
    expect(payload.reasoning_effort).to.equal("high");
  });

  it("uses the GLM full endpoint and filters reasoning, MCP, and Codex-only fields", async function () {
    const provider = new OpenAICompatProvider();
    const capture = await withMockedHttp(
      {
        kind: "json",
        body: {
          choices: [{ message: { content: "GLM OK" } }],
        },
      },
      async (request) => {
        const result = await provider.generateSummary(
          "正文",
          false,
          "请总结",
          profileOptions("zhipu-glm-coding", {
            reasoningEffort: "high",
            mcpEnabled: true,
            approvalPolicy: "never",
            sandboxPolicy: "read-only",
            executionId: "codex-must-not-leak",
            vendorOptions: {
              reasoning_effort: "high",
              mcp: true,
              codexContract: { write: true },
            },
          }),
        );
        expect(result).to.equal("GLM OK");
        return request;
      },
    );

    expect(capture.url).to.equal(GLM_URL);
    expect(capture.options.headers?.Authorization).to.equal(`Bearer ${SECRET}`);
    const payload = getCapturedPayload(capture);
    expect(payload.model).to.equal("glm-5.3");
    expect(payload.stream).to.equal(false);
    expect(payload).to.not.have.property("reasoning_effort");
    expect(payload).to.not.have.property("mcpEnabled");
    expect(payload).to.not.have.property("mcp");
    expect(payload).to.not.have.property("approvalPolicy");
    expect(payload).to.not.have.property("sandboxPolicy");
    expect(payload).to.not.have.property("executionId");
    expect(JSON.stringify(payload)).to.not.contain("codex-must-not-leak");
  });

  it("rejects Base64 PDF input for both HTTP Coding Plan profiles", async function () {
    for (const profile of ["kimi-code", "zhipu-glm-coding"] as const) {
      const provider = new OpenAICompatProvider();
      const error = await expectRejected(
        withMockedHttp(
          {
            kind: "json",
            body: { choices: [{ message: { content: "must not be used" } }] },
          },
          () =>
            provider.generateSummary(
              "JVBERi0xLjQK",
              true,
              "请阅读 PDF",
              profileOptions(profile),
            ),
        ),
      );
      expect(error.message).to.match(/base64|PDF|不支持|unsupported/i);
    }
  });

  it("does not append a Chat Completions path to an explicit profile endpoint", async function () {
    const provider = new OpenAICompatProvider();
    const explicitUrl = "https://proxy.example.test/custom-endpoint";
    const capture = await withMockedHttp(
      {
        kind: "json",
        body: { choices: [{ message: { content: "ok" } }] },
      },
      async (request) => {
        await provider.generateSummary(
          "正文",
          false,
          "请总结",
          profileOptions("kimi-code", { apiUrl: explicitUrl }),
        );
        return request;
      },
    );
    expect(capture.url).to.equal(explicitUrl);
  });

  it("maps Kimi 401 to a stable unauthorized code and redacts credentials and bodies", async function () {
    const provider = new OpenAICompatProvider();
    const error = await expectRejected(
      withMockedHttp(
        {
          kind: "error",
          status: 401,
          body: JSON.stringify({
            error: {
              code: "unauthorized",
              message: `bad api_key=${SECRET}`,
            },
          }),
          headers: "authorization: Bearer " + SECRET + "\n",
        },
        (request) =>
          provider
            .testConnection(
              profileOptions("kimi-code", {
                apiUrl: `${KIMI_URL}?api_key=${SECRET}`,
              }),
            )
            .then(() => request),
      ),
    );

    expect(error).to.be.instanceOf(APITestError);
    expect((error as any).code).to.equal("coding-plan/kimi-code/unauthorized");
    const report = (error as APITestError).formatReport();
    expect(report).to.not.contain(SECRET);
    expect((error as APITestError).details.requestBody).to.equal("[REDACTED]");
    expect(
      (error as APITestError).details.responseHeaders?.authorization,
    ).to.equal("[REDACTED]");
  });

  it("maps GLM 429 and unsupported parameters to stable vendor codes", async function () {
    const provider = new OpenAICompatProvider();
    const rateLimit = await expectRejected(
      withMockedHttp(
        {
          kind: "error",
          status: 429,
          body: JSON.stringify({
            error: { code: "rate_limit", message: "too many requests" },
          }),
        },
        () => provider.testConnection(profileOptions("zhipu-glm-coding")),
      ),
    );
    expect((rateLimit as any).code).to.equal(
      "coding-plan/zhipu-glm-coding/rate-limit",
    );

    const unsupported = await expectRejected(
      withMockedHttp(
        {
          kind: "error",
          status: 400,
          body: JSON.stringify({
            error: {
              code: "parameter_error",
              message: "unsupported parameter: reasoning_effort",
            },
          }),
        },
        () => provider.testConnection(profileOptions("zhipu-glm-coding")),
      ),
    );
    expect((unsupported as any).code).to.equal(
      "coding-plan/zhipu-glm-coding/unsupported-parameter",
    );
  });

  it("classifies Coding Plan timeout and malformed response without exposing the key", async function () {
    const provider = new OpenAICompatProvider();
    const timeout = await expectRejected(
      withMockedHttp({ kind: "timeout", errorMessage: "request timeout" }, () =>
        provider.generateSummary(
          "正文",
          false,
          "请总结",
          profileOptions("kimi-code", { requestTimeoutMs: 1 }),
        ),
      ),
    );
    expect((timeout as any).code).to.equal("coding-plan/kimi-code/timeout");
    expect(timeout.message).to.not.contain(SECRET);

    const malformed = await expectRejected(
      withMockedHttp({ kind: "json", body: "{not-json" }, () =>
        provider.generateSummary(
          "正文",
          false,
          "请总结",
          profileOptions("kimi-code"),
        ),
      ),
    );
    expect((malformed as any).code).to.equal(
      "coding-plan/kimi-code/malformed-response",
    );
  });
});
