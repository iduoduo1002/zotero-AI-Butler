import { expect } from "chai";
import { config } from "../package.json";
import {
  LLMEndpointManager,
  type LLMEndpoint,
} from "../src/modules/llmEndpointManager";
import LLMService from "../src/modules/llmService";
import { ProviderRegistry } from "../src/modules/llmproviders/ProviderRegistry";
import {
  normalizeReasoningEffortSetting,
  resolveReasoningEffort,
} from "../src/modules/llmproviders/shared/reasoning";

const prefKeys = [
  "llmEndpoints",
  "llmRoutingStrategy",
  "llmRoundRobinCursor",
  "multiModelSummaryEnabled",
  "multiModelSummaryEndpointIds",
  "maxApiSwitchCount",
  "reasoningEffort",
  "pdfProcessMode",
  "provider",
  "openaiApiUrl",
  "openaiApiKey",
  "openaiApiModel",
  "openaiCompatApiUrl",
  "openaiCompatApiKey",
  "openaiCompatModel",
  "geminiApiUrl",
  "geminiApiKey",
  "geminiModel",
  "anthropicApiUrl",
  "anthropicApiKey",
  "anthropicModel",
  "openRouterApiUrl",
  "openRouterApiKey",
  "openRouterModel",
  "volcanoArkApiUrl",
  "volcanoArkApiKey",
  "volcanoArkModel",
  "ollamaApiUrl",
  "ollamaApiKey",
  "ollamaModel",
  "codexRole",
  "codexBinaryPath",
  "codexModel",
  "codexReasoningEffort",
  "codexApprovalPolicy",
  "codexSandboxPolicy",
  "codexNetworkAccess",
  "codexMcpEnabled",
];

function prefName(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

function makeEndpoint(id: string, enabled = true): LLMEndpoint {
  return {
    id,
    name: id.toUpperCase(),
    providerType: "openai",
    apiUrl: "https://api.openai.com/v1/responses",
    apiKey: `sk-${id}`,
    model: "gpt-5",
    enabled,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("LLMEndpointManager", function () {
  const originals = new Map<string, unknown>();

  beforeEach(function () {
    originals.clear();
    for (const key of prefKeys) {
      const fullKey = prefName(key);
      originals.set(key, Zotero.Prefs.get(fullKey, true));
      Zotero.Prefs.clear(fullKey, true);
    }
  });

  afterEach(function () {
    for (const key of prefKeys) {
      const fullKey = prefName(key);
      const value = originals.get(key);
      if (value === undefined) Zotero.Prefs.clear(fullKey, true);
      else Zotero.Prefs.set(fullKey, value as any, true);
    }
  });

  it("enumerates Codex App Server and creates safe Sol defaults", function () {
    expect(LLMEndpointManager.providerTypes()).to.include("codex-app-server");

    const endpoint = LLMEndpointManager.createEndpoint(
      "codex-app-server" as any,
    );

    expect(endpoint).to.include({
      providerType: "codex-app-server",
      apiUrl: "",
      apiKey: "",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      codexRole: "sol",
      codexBinaryPath: "",
      approvalPolicy: "on-request",
      sandboxPolicy: "read-only",
      networkAccess: false,
      mcpEnabled: false,
      pdfProcessMode: "text",
    });
  });

  it("normalizes a Codex Luna endpoint to the Luna defaults", function () {
    LLMEndpointManager.saveEndpoints([
      {
        ...makeEndpoint("codex-luna"),
        providerType: "codex-app-server" as any,
        apiUrl: "",
        apiKey: "",
        model: "",
        reasoningEffort: "default",
        codexRole: "luna" as any,
        pdfProcessMode: undefined,
      } as any,
    ]);

    const [endpoint] = LLMEndpointManager.getEndpoints();

    expect(endpoint).to.include({
      providerType: "codex-app-server",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      codexRole: "luna",
      pdfProcessMode: "text",
    });
  });

  it("allows Codex endpoints without API URL or API key when a model is set", function () {
    const endpoint = {
      ...LLMEndpointManager.createEndpoint("codex-app-server" as any),
      apiUrl: "",
      apiKey: "",
      model: "gpt-5.6-sol",
    } as any;

    expect(LLMEndpointManager.isEndpointUsable(endpoint)).to.equal(true);
    expect(LLMEndpointManager.validateEndpoint(endpoint)).to.deep.equal([]);
  });

  it("falls back to the legacy OpenAI provider for unknown stored provider values", function () {
    Zotero.Prefs.set(
      prefName("llmEndpoints"),
      JSON.stringify([
        {
          ...makeEndpoint("unknown-provider"),
          providerType: "codex-unknown-provider",
        },
      ]),
      true,
    );

    const [endpoint] = LLMEndpointManager.getEndpoints();

    expect(endpoint.providerType).to.equal("openai");
  });

  it("defaults Codex PDF processing to extracted text", function () {
    LLMEndpointManager.saveEndpoints([
      {
        ...LLMEndpointManager.createEndpoint("codex-app-server" as any),
        pdfProcessMode: undefined,
      } as any,
    ]);

    expect(LLMEndpointManager.getEndpoints()[0].pdfProcessMode).to.equal(
      "text",
    );
  });

  it("migrates legacy Codex preferences without introducing API credentials", function () {
    Zotero.Prefs.set(prefName("llmEndpoints"), "[]", true);
    Zotero.Prefs.set(prefName("provider"), "codex-app-server", true);
    Zotero.Prefs.set(prefName("codexRole"), "luna", true);
    Zotero.Prefs.set(
      prefName("codexBinaryPath"),
      " /usr/local/bin/codex ",
      true,
    );
    Zotero.Prefs.set(prefName("codexModel"), "", true);
    Zotero.Prefs.set(prefName("codexNetworkAccess"), true, true);
    Zotero.Prefs.set(prefName("codexMcpEnabled"), true, true);

    const [endpoint] = LLMEndpointManager.getEndpoints();

    expect(endpoint).to.include({
      id: "endpoint-legacy-primary",
      providerType: "codex-app-server",
      apiUrl: "",
      apiKey: "",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      codexRole: "luna",
      codexBinaryPath: "/usr/local/bin/codex",
      networkAccess: true,
      mcpEnabled: true,
      pdfProcessMode: "text",
    });
  });

  it("honors an explicit legacy Codex reasoning override for the Luna role", function () {
    Zotero.Prefs.set(prefName("llmEndpoints"), "[]", true);
    Zotero.Prefs.set(prefName("provider"), "codex-app-server", true);
    Zotero.Prefs.set(prefName("codexRole"), "luna", true);
    Zotero.Prefs.set(prefName("codexModel"), "", true);
    Zotero.Prefs.set(prefName("codexReasoningEffort"), "low", true);

    const [endpoint] = LLMEndpointManager.getEndpoints();

    expect(endpoint.codexRole).to.equal("luna");
    expect(endpoint.reasoningEffort).to.equal("low");
  });

  it("uses the Codex role model when codexModel is only a shipped default", function () {
    Zotero.Prefs.set(prefName("llmEndpoints"), "[]", true);
    Zotero.Prefs.set(prefName("provider"), "codex-app-server", true);
    Zotero.Prefs.set(prefName("codexRole"), "luna", true);

    const [endpoint] = LLMEndpointManager.getEndpoints();

    expect(endpoint.model).to.equal("gpt-5.6-luna");
    expect(endpoint.reasoningEffort).to.equal("max");
  });

  it("preserves an explicit legacy Codex model for the selected role", function () {
    Zotero.Prefs.set(prefName("llmEndpoints"), "[]", true);
    Zotero.Prefs.set(prefName("provider"), "codex-app-server", true);
    Zotero.Prefs.set(prefName("codexRole"), "luna", true);
    Zotero.Prefs.set(prefName("codexModel"), "custom-luna-model", true);

    const [endpoint] = LLMEndpointManager.getEndpoints();

    expect(endpoint.model).to.equal("custom-luna-model");
    expect(endpoint.reasoningEffort).to.equal("max");
  });

  it("maps Codex endpoint fields into LLMOptions without dropping Luna max effort", function () {
    const endpoint = LLMEndpointManager.createEndpoint(
      "codex-app-server",
      "luna",
    );
    endpoint.codexBinaryPath = "/usr/local/bin/codex";
    endpoint.approvalPolicy = "never";
    endpoint.sandboxPolicy = "workspace-write";
    endpoint.networkAccess = true;
    endpoint.mcpEnabled = false;

    const options = LLMService.buildOptions(endpoint, undefined, {
      stream: false,
    });

    expect(options).to.include({
      apiUrl: "",
      apiKey: "",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      role: "luna",
      codexBinaryPath: "/usr/local/bin/codex",
      approvalPolicy: "never",
      sandboxPolicy: "workspace-write",
      networkAccess: true,
      mcpEnabled: false,
    });
  });

  it("keeps Codex outside legacy API-key provider rotation", function () {
    expect(LLMService.mapToKeyManagerId("codex-app-server")).to.equal(
      "codex-app-server",
    );
  });

  it("passes MCP enabled through the connection path for runtime fail-closed handling", async function () {
    const endpoint = LLMEndpointManager.createEndpoint(
      "codex-app-server",
      "luna",
    );
    endpoint.mcpEnabled = true;
    const provider = ProviderRegistry.get("codex-app-server");
    expect(provider).to.not.equal(undefined);
    const originalTestConnection = provider!.testConnection;
    let capturedOptions: Record<string, unknown> | undefined;
    provider!.testConnection = async (options) => {
      capturedOptions = options as unknown as Record<string, unknown>;
      throw new Error("codex-mcp-reserved");
    };

    let error: unknown;
    try {
      await LLMService.testEndpointConnection(endpoint);
    } catch (caught) {
      error = caught;
    } finally {
      provider!.testConnection = originalTestConnection;
    }

    expect((error as Error)?.message).to.equal("codex-mcp-reserved");
    expect(capturedOptions).to.include({
      role: "luna",
      reasoningEffort: "max",
      mcpEnabled: true,
    });
  });

  it("gates max reasoning to Codex while preserving legacy normalizer defaults", function () {
    expect(normalizeReasoningEffortSetting("max")).to.equal("default");
    expect(
      normalizeReasoningEffortSetting("max", "default", { allowMax: true }),
    ).to.equal("max");
    expect(resolveReasoningEffort("max", { allowMax: true })).to.equal("max");
  });

  it("forces persisted Codex PDF modes to extracted text", function () {
    for (const mode of ["base64", "global", "mineru", undefined]) {
      LLMEndpointManager.saveEndpoints([
        {
          ...LLMEndpointManager.createEndpoint("codex-app-server"),
          pdfProcessMode: mode as any,
        },
      ]);

      const [endpoint] = LLMEndpointManager.getEndpoints();
      expect(endpoint.pdfProcessMode, mode).to.equal("text");
      expect(
        LLMEndpointManager.getEffectivePdfProcessMode(endpoint),
        mode,
      ).to.equal("text");
    }
  });

  it("migrates an empty endpoint list from legacy provider prefs", function () {
    Zotero.Prefs.set(prefName("llmEndpoints"), "[]", true);
    Zotero.Prefs.set(prefName("provider"), "openai-compat", true);
    Zotero.Prefs.set(
      prefName("openaiCompatApiUrl"),
      "https://example.test/v1/chat/completions",
      true,
    );
    Zotero.Prefs.set(prefName("openaiCompatApiKey"), "sk-legacy", true);
    Zotero.Prefs.set(prefName("openaiCompatModel"), "legacy-model", true);

    const endpoints = LLMEndpointManager.getEndpoints();

    expect(endpoints).to.have.length(1);
    expect(endpoints[0]).to.include({
      id: "endpoint-legacy-primary",
      providerType: "openai-compat",
      apiUrl: "https://example.test/v1/chat/completions",
      apiKey: "sk-legacy",
      model: "legacy-model",
      reasoningEffort: "default",
      enabled: true,
    });
  });

  it("defaults official OpenAI endpoints to medium reasoning effort", function () {
    Zotero.Prefs.set(prefName("llmEndpoints"), "[]", true);
    Zotero.Prefs.set(prefName("provider"), "openai", true);

    const endpoints = LLMEndpointManager.getEndpoints();

    expect(endpoints[0]).to.include({
      providerType: "openai",
      reasoningEffort: "medium",
    });
  });

  it("syncs the migrated legacy endpoint from current provider prefs", function () {
    LLMEndpointManager.saveEndpoints([
      {
        ...makeEndpoint("endpoint-legacy-primary"),
        apiKey: "",
        model: "",
      },
    ]);
    Zotero.Prefs.set(prefName("provider"), "google", true);
    Zotero.Prefs.set(
      prefName("geminiApiUrl"),
      "https://generativelanguage.googleapis.com",
      true,
    );
    Zotero.Prefs.set(prefName("geminiApiKey"), "gemini-key", true);
    Zotero.Prefs.set(prefName("geminiModel"), "gemini-test-model", true);

    const synced = LLMEndpointManager.syncLegacyPrimaryEndpointFromPrefs();
    const endpoints = LLMEndpointManager.getEndpoints();

    expect(synced).not.to.equal(null);
    expect(synced!).to.include({
      id: "endpoint-legacy-primary",
      providerType: "google",
      apiKey: "gemini-key",
      model: "gemini-test-model",
      enabled: true,
    });
    expect(endpoints).to.have.length(1);
    expect(LLMEndpointManager.isEndpointUsable(endpoints[0])).to.equal(true);
  });

  it("does not overwrite manually created endpoints during legacy sync", function () {
    LLMEndpointManager.saveEndpoints([makeEndpoint("manual")]);
    Zotero.Prefs.set(prefName("provider"), "google", true);
    Zotero.Prefs.set(prefName("geminiApiKey"), "gemini-key", true);
    Zotero.Prefs.set(prefName("geminiModel"), "gemini-test-model", true);

    const synced = LLMEndpointManager.syncLegacyPrimaryEndpointFromPrefs();
    const endpoints = LLMEndpointManager.getEndpoints();

    expect(synced).to.equal(null);
    expect(endpoints).to.have.length(1);
    expect(endpoints[0]).to.include({
      id: "manual",
      providerType: "openai",
      apiKey: "sk-manual",
      model: "gpt-5",
    });
  });

  it("normalizes stored reasoning effort values", function () {
    LLMEndpointManager.saveEndpoints([
      { ...makeEndpoint("a"), reasoningEffort: "high" },
      {
        ...makeEndpoint("b"),
        providerType: "openai-compat",
        reasoningEffort: "invalid" as any,
      },
    ]);

    const endpoints = LLMEndpointManager.getEndpoints();

    expect(endpoints[0].reasoningEffort).to.equal("high");
    expect(endpoints[1].reasoningEffort).to.equal("default");
  });

  it("normalizes endpoint PDF modes and resolves global fallback", function () {
    Zotero.Prefs.set(prefName("pdfProcessMode"), "mineru", true);
    LLMEndpointManager.saveEndpoints([
      { ...makeEndpoint("a"), pdfProcessMode: "text" },
      { ...makeEndpoint("b"), pdfProcessMode: "invalid" as any },
    ]);

    const endpoints = LLMEndpointManager.getEndpoints();

    expect(endpoints[0].pdfProcessMode).to.equal("text");
    expect(endpoints[1].pdfProcessMode).to.equal("global");
    expect(
      LLMEndpointManager.getEffectivePdfProcessMode(endpoints[0]),
    ).to.equal("text");
    expect(
      LLMEndpointManager.getEffectivePdfProcessMode(endpoints[1]),
    ).to.equal("mineru");
  });

  it("returns priority route order and skips disabled endpoints", function () {
    LLMEndpointManager.saveEndpoints([
      makeEndpoint("a"),
      makeEndpoint("b", false),
      makeEndpoint("c"),
    ]);
    LLMEndpointManager.setRoutingStrategy("priority");
    Zotero.Prefs.set(prefName("maxApiSwitchCount"), "5", true);

    const route = LLMEndpointManager.prepareRoute();

    expect(route.strategy).to.equal("priority");
    expect(route.maxAttempts).to.equal(5);
    expect(route.endpoints.map((endpoint) => endpoint.id)).to.deep.equal([
      "a",
      "c",
    ]);
  });

  it("advances round-robin cursor after each attempted endpoint", function () {
    LLMEndpointManager.saveEndpoints([
      makeEndpoint("a"),
      makeEndpoint("b"),
      makeEndpoint("c"),
      makeEndpoint("d"),
    ]);
    LLMEndpointManager.setRoutingStrategy("roundRobin");
    Zotero.Prefs.set(prefName("llmRoundRobinCursor"), "b", true);

    const route = LLMEndpointManager.prepareRoute();
    expect(route.endpoints.map((endpoint) => endpoint.id)).to.deep.equal([
      "b",
      "c",
      "d",
      "a",
    ]);

    LLMEndpointManager.markEndpointAttempted("b");
    expect(Zotero.Prefs.get(prefName("llmRoundRobinCursor"), true)).to.equal(
      "c",
    );
    LLMEndpointManager.markEndpointAttempted("c");
    expect(Zotero.Prefs.get(prefName("llmRoundRobinCursor"), true)).to.equal(
      "d",
    );
  });

  it("throws clearly when no enabled endpoint exists", function () {
    LLMEndpointManager.saveEndpoints([makeEndpoint("a", false)]);

    expect(() => LLMEndpointManager.prepareRoute()).to.throw(
      "未配置可用的 LLM Endpoint",
    );
  });

  it("allows Ollama endpoints without API keys", function () {
    const endpoint: LLMEndpoint = {
      ...makeEndpoint("ollama"),
      providerType: "ollama",
      apiUrl: "http://localhost:11434",
      apiKey: "",
      model: "llama3.2",
    };

    expect(LLMEndpointManager.validateEndpoint(endpoint)).to.deep.equal([]);
    LLMEndpointManager.saveEndpoints([endpoint]);

    const route = LLMEndpointManager.prepareRoute();
    expect(route.endpoints[0]).to.include({
      providerType: "ollama",
      apiKey: "",
      model: "llama3.2",
    });
  });

  it("returns selected enabled endpoints for multi-model summaries", function () {
    LLMEndpointManager.saveEndpoints([
      makeEndpoint("a"),
      makeEndpoint("b", false),
      makeEndpoint("c"),
    ]);
    LLMEndpointManager.setMultiModelSummaryEnabled(true);
    LLMEndpointManager.setMultiModelSummaryEndpointIds([
      "c",
      "missing",
      "b",
      "c",
      "a",
    ]);

    expect(LLMEndpointManager.isMultiModelSummaryEnabled()).to.equal(true);
    expect(LLMEndpointManager.getMultiModelSummaryEndpointIds()).to.deep.equal([
      "c",
      "missing",
      "b",
      "a",
    ]);
    expect(
      LLMEndpointManager.getMultiModelSummaryEndpoints().map(
        (endpoint) => endpoint.id,
      ),
    ).to.deep.equal(["c", "a"]);
  });
});
