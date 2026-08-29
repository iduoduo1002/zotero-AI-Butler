import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { config } from "../../package.json";
import type { ProviderId } from "./apiKeyManager";
import {
  getCodingPlanProfile,
  type CodingPlanProfile,
  type CodingPlanVendor,
} from "./codingPlanProfiles";
import { normalizeReasoningEffortSetting } from "./llmproviders/shared/reasoning";
import type { LLMReasoningEffortSetting } from "./llmproviders/types";

export type LLMEndpointProviderType = ProviderId;
export type LLMRoutingStrategy = "priority" | "roundRobin";
export type LLMPdfProcessMode = "base64" | "text" | "mineru";
export type LLMEndpointPdfProcessMode = "global" | LLMPdfProcessMode;
export type LLMCodexRole = "sol" | "luna";
export type LLMCodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type LLMCodexSandboxPolicy =
  "read-only" | "workspace-write" | "danger-full-access";
export type LLMEndpointReasoningEffort = LLMReasoningEffortSetting | "max";
export type LLMClaudePermissionMode = "plan";
export type LLMClaudeOutputFormat = "stream-json";

export interface LLMEndpoint {
  id: string;
  name: string;
  providerType: LLMEndpointProviderType;
  apiUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: LLMEndpointReasoningEffort;
  codexRole?: LLMCodexRole;
  codexBinaryPath?: string;
  approvalPolicy?: LLMCodexApprovalPolicy | Record<string, unknown>;
  sandboxPolicy?: LLMCodexSandboxPolicy | Record<string, unknown>;
  networkAccess?: boolean;
  mcpEnabled?: boolean;
  codingPlanVendor?: CodingPlanVendor;
  codingPlanProfile?: string;
  claudeBinaryPath?: string;
  claudePermissionMode?: LLMClaudePermissionMode;
  claudeRestricted?: boolean;
  claudeOutputFormat?: LLMClaudeOutputFormat;
  pdfProcessMode?: LLMEndpointPdfProcessMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LLMEndpointRoute {
  endpoints: LLMEndpoint[];
  strategy: LLMRoutingStrategy;
  maxAttempts: number;
}

export interface ProviderDefaults {
  label: string;
  apiUrl: string;
  model: string;
  reasoningEffort?: LLMEndpointReasoningEffort;
}

type ProviderDefaultsConfig = Omit<ProviderDefaults, "label"> & {
  labelKey?: string;
};

const PROVIDER_DEFAULTS: Record<
  LLMEndpointProviderType,
  ProviderDefaultsConfig
> = {
  "openai-compat": {
    labelKey: "llm-endpoint-provider-openai-compat",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-3.5-turbo",
    reasoningEffort: "default",
  },
  openai: {
    labelKey: "llm-endpoint-provider-openai",
    apiUrl: "https://api.openai.com/v1/responses",
    model: "gpt-5",
    reasoningEffort: "medium",
  },
  google: {
    labelKey: "llm-endpoint-provider-google",
    apiUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-pro",
    reasoningEffort: "default",
  },
  anthropic: {
    labelKey: "llm-endpoint-provider-anthropic",
    apiUrl: "https://api.anthropic.com",
    model: "claude-3-5-sonnet-20241022",
    reasoningEffort: "default",
  },
  openrouter: {
    labelKey: "llm-endpoint-provider-openrouter",
    apiUrl: "https://openrouter.ai/api/v1/chat/completions",
    model: "google/gemma-3-27b-it",
    reasoningEffort: "default",
  },
  volcanoark: {
    labelKey: "llm-endpoint-provider-volcanoark",
    apiUrl: "https://ark.cn-beijing.volces.com/api/v3/responses",
    model: "doubao-seed-1-8-251228",
    reasoningEffort: "default",
  },
  ollama: {
    labelKey: "llm-endpoint-provider-ollama",
    apiUrl: "http://localhost:11434",
    model: "llama3.2",
    reasoningEffort: "default",
  },
  "codex-app-server": {
    labelKey: "llm-endpoint-provider-codex-app-server",
    apiUrl: "",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  },
  "claude-code-cli": {
    apiUrl: "",
    model: "sonnet",
    reasoningEffort: "default",
  },
};

const PROVIDER_TYPES = Object.keys(
  PROVIDER_DEFAULTS,
) as LLMEndpointProviderType[];

const LEGACY_PRIMARY_ENDPOINT_ID = "endpoint-legacy-primary";
const CODEX_DEFAULT_APPROVAL_POLICY: LLMCodexApprovalPolicy = "on-request";
const CODEX_DEFAULT_SANDBOX_POLICY: LLMCodexSandboxPolicy = "read-only";
const CODEX_DEFAULT_NETWORK_ACCESS = false;
const CODEX_DEFAULT_MCP_ENABLED = false;

const CODEX_ROLE_DEFAULTS: Record<
  LLMCodexRole,
  { model: string; reasoningEffort: LLMEndpointReasoningEffort }
> = {
  sol: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  luna: { model: "gpt-5.6-luna", reasoningEffort: "max" },
};

function nowIso(): string {
  return new Date().toISOString();
}

function getUserPreference(key: string): unknown {
  const fullKey = `${config.prefsPrefix}.${key}`;
  const zoteroPrefs = (globalThis as any).Zotero?.Prefs;
  const zoteroRootBranch = zoteroPrefs?.rootBranch;
  const servicesPrefs = (globalThis as any).Services?.prefs;
  const checkerOwner =
    typeof zoteroRootBranch?.prefHasUserValue === "function"
      ? zoteroRootBranch
      : typeof zoteroPrefs?.prefHasUserValue === "function"
        ? zoteroPrefs
        : typeof servicesPrefs?.prefHasUserValue === "function"
          ? servicesPrefs
          : undefined;
  if (checkerOwner) {
    try {
      if (!checkerOwner.prefHasUserValue(fullKey)) return undefined;
    } catch {
      // Fall through to the compatibility read below.
    }
  }
  return getPref(key as any);
}

function makeEndpointId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `endpoint-${Date.now().toString(36)}-${random}`;
}

function safeProviderType(raw: unknown): LLMEndpointProviderType {
  const value = String(raw || "").toLowerCase();
  if (value.includes("gemini")) return "google";
  if (value === "claude-code-cli") return "claude-code-cli";
  if (value.includes("claude")) return "anthropic";
  if (value.includes("ollama")) return "ollama";
  if (value === "kimi-code" || value === "zhipu-glm-coding") {
    return "openai-compat";
  }
  if (PROVIDER_TYPES.includes(value as LLMEndpointProviderType)) {
    return value as LLMEndpointProviderType;
  }
  return "openai";
}

function normalizeGlobalPdfProcessMode(raw: unknown): LLMPdfProcessMode {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (value === "text" || value === "mineru") return value;
  return "base64";
}

function normalizeEndpointPdfProcessMode(
  raw: unknown,
): LLMEndpointPdfProcessMode {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (value === "base64" || value === "text" || value === "mineru") {
    return value;
  }
  return "global";
}

function normalizeCodexRole(raw: unknown): LLMCodexRole {
  return String(raw || "")
    .trim()
    .toLowerCase() === "luna"
    ? "luna"
    : "sol";
}

function normalizeCodexReasoningEffort(
  raw: unknown,
  fallback: LLMEndpointReasoningEffort,
): LLMEndpointReasoningEffort {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (
    !value ||
    value === "default" ||
    value === "auto" ||
    value === "inherit"
  ) {
    return fallback;
  }
  if (value === "max") return "max";
  const normalized = normalizeReasoningEffortSetting(value, "default");
  return normalized === "default" ? fallback : normalized;
}

function normalizeCodexApprovalPolicy(
  raw: unknown,
): LLMCodexApprovalPolicy | Record<string, unknown> {
  if (raw === "untrusted" || raw === "on-request" || raw === "never") {
    return raw;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return CODEX_DEFAULT_APPROVAL_POLICY;
}

function normalizeCodexSandboxPolicy(
  raw: unknown,
): LLMCodexSandboxPolicy | Record<string, unknown> {
  if (
    raw === "read-only" ||
    raw === "workspace-write" ||
    raw === "danger-full-access"
  ) {
    return raw;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return CODEX_DEFAULT_SANDBOX_POLICY;
}

function normalizeCodexPdfProcessMode(
  _raw: unknown,
): LLMEndpointPdfProcessMode {
  return "text";
}

function normalizeCodingPlanPdfProcessMode(
  raw: unknown,
  profile?: CodingPlanProfile,
): LLMEndpointPdfProcessMode {
  const mode = normalizeEndpointPdfProcessMode(raw);
  if (!profile || profile.supportsPdfBase64) return mode;
  return mode === "mineru" || mode === "text" ? mode : "text";
}

function normalizeClaudePermissionMode(raw: unknown): LLMClaudePermissionMode {
  return String(raw || "")
    .trim()
    .toLowerCase() === "plan"
    ? "plan"
    : "plan";
}

function normalizeClaudeOutputFormat(raw: unknown): LLMClaudeOutputFormat {
  return String(raw || "")
    .trim()
    .toLowerCase() === "stream-json"
    ? "stream-json"
    : "stream-json";
}

function endpointCodingPlanProfile(
  raw: Partial<LLMEndpoint>,
  providerType: LLMEndpointProviderType,
): CodingPlanProfile | undefined {
  const requestedProfile = String(raw.codingPlanProfile || "").trim();
  const requestedVendor = String(raw.codingPlanVendor || "").trim();
  const providerAlias = String(raw.providerType || "").trim();
  const requestedId =
    requestedProfile ||
    requestedVendor ||
    providerAlias ||
    (providerType === "claude-code-cli" ? providerType : "");
  if (!requestedId) return undefined;

  const profile = getCodingPlanProfile(requestedId);
  if (!profile) return undefined;
  if (requestedVendor && requestedVendor.toLowerCase() !== profile.id) {
    return undefined;
  }
  return profile;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeEndpoint(
  raw: Partial<LLMEndpoint>,
  fallbackIndex: number,
): LLMEndpoint {
  let providerType = safeProviderType(raw.providerType);
  const codingPlanProfile = endpointCodingPlanProfile(raw, providerType);
  if (codingPlanProfile?.id === "claude-code-cli") {
    providerType = "claude-code-cli";
  } else if (codingPlanProfile) {
    providerType = "openai-compat";
  }
  const codex = providerType === "codex-app-server";
  const claude = providerType === "claude-code-cli";
  const codexRole = codex ? normalizeCodexRole(raw.codexRole) : undefined;
  const defaults = providerDefaults(providerType);
  const roleDefaults = codex ? CODEX_ROLE_DEFAULTS[codexRole!] : undefined;
  const createdAt = raw.createdAt || nowIso();
  const model = String(raw.model || "").trim();
  const reasoningEffort = codex
    ? normalizeCodexReasoningEffort(
        raw.reasoningEffort,
        roleDefaults!.reasoningEffort,
      )
    : normalizeReasoningEffortSetting(
        raw.reasoningEffort,
        (defaults.reasoningEffort as LLMReasoningEffortSetting) || "default",
      );
  const endpointPdfProcessMode = codex
    ? normalizeCodexPdfProcessMode(raw.pdfProcessMode)
    : normalizeCodingPlanPdfProcessMode(raw.pdfProcessMode, codingPlanProfile);
  return {
    id: String(raw.id || "").trim() || makeEndpointId(),
    name:
      String(raw.name || "").trim() || `${defaults.label} ${fallbackIndex + 1}`,
    providerType,
    apiUrl:
      codex || claude
        ? ""
        : String(
            raw.apiUrl || codingPlanProfile?.defaultApiUrl || defaults.apiUrl,
          ).trim(),
    apiKey: codex || claude ? "" : String(raw.apiKey || "").trim(),
    model:
      model ||
      codingPlanProfile?.defaultModel ||
      roleDefaults?.model ||
      defaults.model,
    reasoningEffort,
    ...(codingPlanProfile
      ? {
          codingPlanVendor: codingPlanProfile.id,
          codingPlanProfile: codingPlanProfile.id,
        }
      : {}),
    ...(codex
      ? {
          codexRole,
          codexBinaryPath: String(raw.codexBinaryPath || "").trim(),
          approvalPolicy: normalizeCodexApprovalPolicy(raw.approvalPolicy),
          sandboxPolicy: normalizeCodexSandboxPolicy(raw.sandboxPolicy),
          networkAccess: raw.networkAccess === true,
          mcpEnabled: raw.mcpEnabled === true,
        }
      : {}),
    ...(claude
      ? {
          claudeBinaryPath: String(
            raw.claudeBinaryPath ?? getPref("claudeBinaryPath" as any) ?? "",
          ).trim(),
          claudePermissionMode: normalizeClaudePermissionMode(
            raw.claudePermissionMode ?? getPref("claudePermissionMode" as any),
          ),
          claudeRestricted:
            raw.claudeRestricted ?? getPref("claudeRestricted" as any) ?? true,
          claudeOutputFormat: normalizeClaudeOutputFormat(
            raw.claudeOutputFormat ?? getPref("claudeOutputFormat" as any),
          ),
        }
      : {}),
    pdfProcessMode: endpointPdfProcessMode,
    enabled: raw.enabled !== false,
    createdAt,
    updatedAt: raw.updatedAt || createdAt,
  };
}

function providerDefaults(
  providerType: LLMEndpointProviderType,
): ProviderDefaults {
  const { labelKey, ...defaults } =
    PROVIDER_DEFAULTS[providerType] || PROVIDER_DEFAULTS.openai;
  return {
    ...defaults,
    label:
      getCodingPlanProfile(providerType)?.label ||
      getString(labelKey || "llm-endpoint-provider-openai"),
  };
}

export class LLMEndpointManager {
  static providerTypes(): LLMEndpointProviderType[] {
    return [...PROVIDER_TYPES];
  }

  static normalizeCodexRole(raw: unknown): LLMCodexRole {
    return normalizeCodexRole(raw);
  }

  static normalizeCodexReasoningEffort(
    raw: unknown,
    fallback: string,
  ): LLMEndpointReasoningEffort {
    return normalizeCodexReasoningEffort(
      raw,
      fallback as LLMEndpointReasoningEffort,
    );
  }

  static providerDefaults(
    providerType: LLMEndpointProviderType,
    codexRole: LLMCodexRole = "sol",
  ): ProviderDefaults {
    const normalizedProvider = safeProviderType(providerType);
    const defaults = providerDefaults(normalizedProvider);
    if (normalizedProvider !== "codex-app-server") return defaults;
    return {
      ...defaults,
      ...CODEX_ROLE_DEFAULTS[normalizeCodexRole(codexRole)],
    } as ProviderDefaults;
  }

  static providerLabel(providerType: string): string {
    return this.providerDefaults(safeProviderType(providerType)).label;
  }

  static providerAllowsEmptyApiKey(providerType: string): boolean {
    const normalized = safeProviderType(providerType);
    return (
      normalized === "ollama" ||
      normalized === "codex-app-server" ||
      normalized === "claude-code-cli"
    );
  }

  static isEndpointUsable(
    endpoint: Pick<
      LLMEndpoint,
      "apiUrl" | "apiKey" | "model" | "providerType"
    > &
      Partial<Pick<LLMEndpoint, "claudeBinaryPath">>,
  ): boolean {
    const normalizedProvider = safeProviderType(endpoint.providerType);
    if (normalizedProvider === "codex-app-server") {
      return endpoint.model.trim().length > 0;
    }
    if (normalizedProvider === "claude-code-cli") {
      return (
        endpoint.model.trim().length > 0 &&
        Boolean(endpoint.claudeBinaryPath?.trim())
      );
    }
    return (
      endpoint.apiUrl.trim().length > 0 &&
      endpoint.model.trim().length > 0 &&
      (endpoint.apiKey.trim().length > 0 ||
        this.providerAllowsEmptyApiKey(endpoint.providerType))
    );
  }

  static normalizePdfProcessMode(raw: unknown): LLMEndpointPdfProcessMode {
    return normalizeEndpointPdfProcessMode(raw);
  }

  static getGlobalPdfProcessMode(): LLMPdfProcessMode {
    return normalizeGlobalPdfProcessMode(getPref("pdfProcessMode" as any));
  }

  static getEffectivePdfProcessMode(
    endpoint?:
      | (Pick<LLMEndpoint, "pdfProcessMode"> &
          Partial<Pick<LLMEndpoint, "providerType">>)
      | null,
  ): LLMPdfProcessMode {
    if (endpoint?.providerType === "codex-app-server") return "text";
    const profile = endpointCodingPlanProfile(
      endpoint || {},
      safeProviderType(endpoint?.providerType),
    );
    if (profile && !profile.supportsPdfBase64) {
      const mode = normalizeEndpointPdfProcessMode(endpoint?.pdfProcessMode);
      return mode === "mineru" || mode === "text" ? mode : "text";
    }
    const endpointMode = normalizeEndpointPdfProcessMode(
      endpoint?.pdfProcessMode,
    );
    return endpointMode === "global"
      ? this.getGlobalPdfProcessMode()
      : endpointMode;
  }

  static pdfProcessModeLabel(mode: LLMEndpointPdfProcessMode): string {
    switch (normalizeEndpointPdfProcessMode(mode)) {
      case "base64":
        return getString("endpoint-pdf-base64-short");
      case "text":
        return getString("endpoint-pdf-text-short");
      case "mineru":
        return "MinerU";
      default:
        return getString("endpoint-pdf-global-short");
    }
  }

  static createEndpoint(
    providerType: LLMEndpointProviderType = "openai-compat",
    codexRole: LLMCodexRole = "sol",
  ): LLMEndpoint {
    const normalizedProvider = safeProviderType(providerType);
    const normalizedRole = normalizeCodexRole(codexRole);
    const defaults = this.providerDefaults(normalizedProvider, normalizedRole);
    const codex = normalizedProvider === "codex-app-server";
    const claude = normalizedProvider === "claude-code-cli";
    const codingPlanProfile =
      getCodingPlanProfile(providerType) ||
      (claude ? getCodingPlanProfile("claude-code-cli") : undefined);
    const endpointProvider = codingPlanProfile
      ? codingPlanProfile.id === "claude-code-cli"
        ? "claude-code-cli"
        : "openai-compat"
      : normalizedProvider;
    const endpointIsClaude = endpointProvider === "claude-code-cli";
    const timestamp = nowIso();
    return {
      id: makeEndpointId(),
      name: codingPlanProfile?.label || defaults.label,
      providerType: endpointProvider,
      apiUrl:
        codex || endpointIsClaude
          ? ""
          : codingPlanProfile?.defaultApiUrl || defaults.apiUrl,
      apiKey: "",
      model: codingPlanProfile?.defaultModel || defaults.model,
      reasoningEffort: defaults.reasoningEffort || "default",
      ...(codingPlanProfile
        ? {
            codingPlanVendor: codingPlanProfile.id,
            codingPlanProfile: codingPlanProfile.id,
          }
        : {}),
      ...(codex
        ? {
            codexRole: normalizedRole,
            codexBinaryPath: "",
            approvalPolicy: CODEX_DEFAULT_APPROVAL_POLICY,
            sandboxPolicy: CODEX_DEFAULT_SANDBOX_POLICY,
            networkAccess: CODEX_DEFAULT_NETWORK_ACCESS,
            mcpEnabled: CODEX_DEFAULT_MCP_ENABLED,
          }
        : {}),
      ...(claude
        ? {
            claudeBinaryPath: String(
              getPref("claudeBinaryPath" as any) || "",
            ).trim(),
            claudePermissionMode: normalizeClaudePermissionMode(
              getPref("claudePermissionMode" as any),
            ),
            claudeRestricted: getPref("claudeRestricted" as any) !== false,
            claudeOutputFormat: normalizeClaudeOutputFormat(
              getPref("claudeOutputFormat" as any),
            ),
          }
        : {}),
      pdfProcessMode:
        codex || endpointIsClaude
          ? "text"
          : codingPlanProfile
            ? "text"
            : "global",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  static getEndpoints(): LLMEndpoint[] {
    const stored = this.readStoredEndpoints();
    if (stored.length > 0) return stored;
    const migrated = [this.createLegacyEndpoint()];
    this.saveEndpoints(migrated);
    return migrated;
  }

  static getEnabledEndpoints(): LLMEndpoint[] {
    return this.getEndpoints().filter((endpoint) => endpoint.enabled);
  }

  static saveEndpoints(endpoints: LLMEndpoint[]): void {
    const seen = new Set<string>();
    const normalized = endpoints.map((endpoint, index) => {
      const item = normalizeEndpoint(endpoint, index);
      while (seen.has(item.id)) item.id = makeEndpointId();
      seen.add(item.id);
      item.updatedAt = nowIso();
      return item;
    });
    setPref("llmEndpoints", JSON.stringify(normalized));
  }

  static upsertEndpoint(endpoint: LLMEndpoint): void {
    const endpoints = this.getEndpoints();
    const index = endpoints.findIndex((item) => item.id === endpoint.id);
    if (index >= 0) endpoints[index] = endpoint;
    else endpoints.push(endpoint);
    this.saveEndpoints(endpoints);
  }

  static removeEndpoint(endpointId: string): void {
    this.saveEndpoints(
      this.getEndpoints().filter((endpoint) => endpoint.id !== endpointId),
    );
  }

  static moveEndpoint(endpointId: string, direction: -1 | 1): void {
    const endpoints = this.getEndpoints();
    const index = endpoints.findIndex((endpoint) => endpoint.id === endpointId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= endpoints.length) return;
    const [endpoint] = endpoints.splice(index, 1);
    endpoints.splice(next, 0, endpoint);
    this.saveEndpoints(endpoints);
  }

  static getRoutingStrategy(): LLMRoutingStrategy {
    const raw = String(getPref("llmRoutingStrategy") || "").trim();
    return raw === "roundRobin" ? "roundRobin" : "priority";
  }

  static setRoutingStrategy(strategy: LLMRoutingStrategy): void {
    setPref("llmRoutingStrategy", strategy);
  }

  static getMaxAttemptCount(): number {
    const raw = String(getPref("maxApiSwitchCount" as any) || "3");
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  }

  static prepareRoute(): LLMEndpointRoute {
    let enabled = this.getEnabledEndpoints();
    if (!enabled.some((endpoint) => this.isEndpointUsable(endpoint))) {
      this.syncLegacyPrimaryEndpointFromPrefs();
      enabled = this.getEnabledEndpoints();
    }
    if (enabled.length === 0) {
      throw new Error(getString("llm-error-no-enabled-endpoints"));
    }

    const strategy = this.getRoutingStrategy();
    const maxAttempts = this.getMaxAttemptCount();
    if (strategy === "priority") {
      return { endpoints: enabled, strategy, maxAttempts };
    }

    const cursor = this.getRoundRobinCursor();
    const start = enabled.findIndex((endpoint) => endpoint.id === cursor);
    const startIndex = start >= 0 ? start : 0;
    return {
      endpoints: [
        ...enabled.slice(startIndex),
        ...enabled.slice(0, startIndex),
      ],
      strategy,
      maxAttempts,
    };
  }

  static markEndpointAttempted(endpointId: string): void {
    if (this.getRoutingStrategy() !== "roundRobin") return;
    const enabled = this.getEnabledEndpoints();
    if (enabled.length === 0) return;
    const index = enabled.findIndex((endpoint) => endpoint.id === endpointId);
    const next = enabled[(index >= 0 ? index + 1 : 0) % enabled.length];
    if (next) setPref("llmRoundRobinCursor", next.id);
  }

  static getEndpoint(endpointId: string): LLMEndpoint | undefined {
    return this.getEndpoints().find((endpoint) => endpoint.id === endpointId);
  }

  static isMultiModelSummaryEnabled(): boolean {
    return (getPref("multiModelSummaryEnabled") as boolean) === true;
  }

  static setMultiModelSummaryEnabled(enabled: boolean): void {
    setPref("multiModelSummaryEnabled", enabled);
  }

  static getMultiModelSummaryEndpointIds(): string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const value of parseJsonArray(
      getPref("multiModelSummaryEndpointIds"),
    )) {
      const id = String(value || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  static setMultiModelSummaryEndpointIds(ids: string[]): void {
    const seen = new Set<string>();
    const normalized = ids
      .map((id) => String(id || "").trim())
      .filter((id) => {
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    setPref("multiModelSummaryEndpointIds", JSON.stringify(normalized));
  }

  static getMultiModelSummaryEndpoints(): LLMEndpoint[] {
    const selectedIds = this.getMultiModelSummaryEndpointIds();
    if (selectedIds.length === 0) return [];

    const enabledById = new Map(
      this.getEnabledEndpoints().map((endpoint) => [endpoint.id, endpoint]),
    );
    return selectedIds
      .map((id) => enabledById.get(id))
      .filter((endpoint): endpoint is LLMEndpoint => Boolean(endpoint));
  }

  static validateEndpoint(endpoint: LLMEndpoint): string[] {
    const missing: string[] = [];
    if (!endpoint.name.trim()) missing.push("name");
    const normalizedProvider = safeProviderType(endpoint.providerType);
    const isCodex = normalizedProvider === "codex-app-server";
    const isClaude = normalizedProvider === "claude-code-cli";
    if (!isCodex && !isClaude && !endpoint.apiUrl.trim()) {
      missing.push("apiUrl");
    }
    if (isClaude && !endpoint.claudeBinaryPath?.trim()) {
      missing.push("claudeBinaryPath");
    }
    if (
      !isCodex &&
      !isClaude &&
      !this.providerAllowsEmptyApiKey(endpoint.providerType) &&
      !endpoint.apiKey.trim()
    ) {
      missing.push("apiKey");
    }
    if (!endpoint.model.trim()) missing.push("model");
    return missing;
  }

  static syncLegacyPrimaryEndpointFromPrefs(): LLMEndpoint | null {
    const stored = this.readStoredEndpoints();
    const legacyEndpoint = this.createLegacyEndpoint();

    if (stored.length === 0) {
      this.saveEndpoints([legacyEndpoint]);
      return legacyEndpoint;
    }

    const index = stored.findIndex(
      (endpoint) => endpoint.id === LEGACY_PRIMARY_ENDPOINT_ID,
    );
    if (index < 0) return null;

    const previous = stored[index];
    const synced: LLMEndpoint = {
      ...legacyEndpoint,
      createdAt: previous.createdAt,
      enabled: previous.enabled,
      pdfProcessMode:
        previous.pdfProcessMode ||
        (legacyEndpoint.providerType === "codex-app-server"
          ? "text"
          : "global"),
      ...(legacyEndpoint.providerType === "codex-app-server"
        ? {
            codexRole: previous.codexRole || legacyEndpoint.codexRole,
            codexBinaryPath:
              previous.codexBinaryPath ?? legacyEndpoint.codexBinaryPath,
            approvalPolicy:
              previous.approvalPolicy ?? legacyEndpoint.approvalPolicy,
            sandboxPolicy:
              previous.sandboxPolicy ?? legacyEndpoint.sandboxPolicy,
            networkAccess:
              previous.networkAccess ?? legacyEndpoint.networkAccess,
            mcpEnabled: previous.mcpEnabled ?? legacyEndpoint.mcpEnabled,
          }
        : {}),
    };

    if (this.endpointCoreEquals(previous, synced)) {
      return previous;
    }

    stored[index] = synced;
    this.saveEndpoints(stored);
    return synced;
  }

  private static readStoredEndpoints(): LLMEndpoint[] {
    return parseJsonArray(getPref("llmEndpoints")).map((item, index) =>
      normalizeEndpoint(item as Partial<LLMEndpoint>, index),
    );
  }

  private static getRoundRobinCursor(): string {
    return String(getPref("llmRoundRobinCursor") || "").trim();
  }

  private static createLegacyEndpoint(): LLMEndpoint {
    const configuredProvider = String(
      getPref("provider") || "openai-compat",
    ).trim();
    const configuredProfile = getCodingPlanProfile(configuredProvider);
    const providerType = configuredProfile
      ? configuredProfile.id === "claude-code-cli"
        ? "claude-code-cli"
        : "openai-compat"
      : safeProviderType(configuredProvider);
    const codingPlanProfile =
      configuredProfile || getCodingPlanProfile(providerType);
    const defaults = this.providerDefaults(providerType);
    const timestamp = nowIso();
    const codex = providerType === "codex-app-server";
    const codexRole = codex
      ? normalizeCodexRole(getPref("codexRole" as any))
      : undefined;
    return {
      id: LEGACY_PRIMARY_ENDPOINT_ID,
      name: defaults.label,
      providerType,
      apiUrl:
        codex || providerType === "claude-code-cli"
          ? ""
          : this.getLegacyApiUrl(providerType) ||
            codingPlanProfile?.defaultApiUrl ||
            defaults.apiUrl,
      apiKey:
        codex || providerType === "claude-code-cli"
          ? ""
          : this.getLegacyApiKey(providerType),
      model:
        this.getLegacyModel(providerType) ||
        (codex
          ? CODEX_ROLE_DEFAULTS[codexRole!].model
          : codingPlanProfile?.defaultModel || defaults.model),
      reasoningEffort: this.getLegacyReasoningEffort(providerType, codexRole),
      ...(codingPlanProfile
        ? {
            codingPlanVendor: codingPlanProfile.id,
            codingPlanProfile: codingPlanProfile.id,
          }
        : {}),
      ...(codex
        ? {
            codexRole,
            codexBinaryPath: String(
              getPref("codexBinaryPath" as any) || "",
            ).trim(),
            approvalPolicy: normalizeCodexApprovalPolicy(
              getPref("codexApprovalPolicy" as any),
            ),
            sandboxPolicy: normalizeCodexSandboxPolicy(
              getPref("codexSandboxPolicy" as any),
            ),
            networkAccess: getPref("codexNetworkAccess" as any) === true,
            mcpEnabled: getPref("codexMcpEnabled" as any) === true,
          }
        : {}),
      ...(providerType === "claude-code-cli"
        ? {
            claudeBinaryPath: String(
              getPref("claudeBinaryPath" as any) || "",
            ).trim(),
            claudePermissionMode: normalizeClaudePermissionMode(
              getPref("claudePermissionMode" as any),
            ),
            claudeRestricted: getPref("claudeRestricted" as any) !== false,
            claudeOutputFormat: normalizeClaudeOutputFormat(
              getPref("claudeOutputFormat" as any),
            ),
          }
        : {}),
      pdfProcessMode:
        codex || providerType === "claude-code-cli" ? "text" : "global",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private static getLegacyApiUrl(
    providerType: LLMEndpointProviderType,
  ): string {
    const keyByProvider: Record<LLMEndpointProviderType, string> = {
      openai: "openaiApiUrl",
      "openai-compat": "openaiCompatApiUrl",
      google: "geminiApiUrl",
      anthropic: "anthropicApiUrl",
      openrouter: "openRouterApiUrl",
      volcanoark: "volcanoArkApiUrl",
      ollama: "ollamaApiUrl",
      "codex-app-server": "codexApiUrl",
      "claude-code-cli": "claudeApiUrl",
    };
    return String(getPref(keyByProvider[providerType] as any) || "").trim();
  }

  private static getLegacyApiKey(
    providerType: LLMEndpointProviderType,
  ): string {
    const keyByProvider: Record<LLMEndpointProviderType, string> = {
      openai: "openaiApiKey",
      "openai-compat": "openaiCompatApiKey",
      google: "geminiApiKey",
      anthropic: "anthropicApiKey",
      openrouter: "openRouterApiKey",
      volcanoark: "volcanoArkApiKey",
      ollama: "ollamaApiKey",
      "codex-app-server": "codexApiKey",
      "claude-code-cli": "claudeApiKey",
    };
    const value = String(getPref(keyByProvider[providerType] as any) || "");
    if (providerType === "openai-compat" && !value.trim()) {
      return String(getPref("openaiApiKey") || "").trim();
    }
    return value.trim();
  }

  private static getLegacyModel(providerType: LLMEndpointProviderType): string {
    const keyByProvider: Record<LLMEndpointProviderType, string> = {
      openai: "openaiApiModel",
      "openai-compat": "openaiCompatModel",
      google: "geminiModel",
      anthropic: "anthropicModel",
      openrouter: "openRouterModel",
      volcanoark: "volcanoArkModel",
      ollama: "ollamaModel",
      "codex-app-server": "codexModel",
      "claude-code-cli": "claudeModel",
    };
    const value = String(
      (providerType === "codex-app-server"
        ? getUserPreference("codexModel")
        : getPref(keyByProvider[providerType] as any)) || "",
    );
    if (providerType === "openai-compat" && !value.trim()) {
      return String(getPref("openaiApiModel") || "").trim();
    }
    return value.trim();
  }

  private static getLegacyReasoningEffort(
    providerType: LLMEndpointProviderType,
    codexRole?: LLMCodexRole,
  ): LLMEndpointReasoningEffort {
    const defaults = this.providerDefaults(providerType);
    if (providerType === "codex-app-server") {
      const role = normalizeCodexRole(codexRole);
      const configuredCodexEffort = getUserPreference("codexReasoningEffort");
      const configuredGeneralEffort = getUserPreference("reasoningEffort");
      return normalizeCodexReasoningEffort(
        configuredCodexEffort ?? configuredGeneralEffort,
        CODEX_ROLE_DEFAULTS[role].reasoningEffort,
      );
    }
    const reasoningEffort = normalizeReasoningEffortSetting(
      getPref("reasoningEffort" as any),
      (defaults.reasoningEffort as LLMReasoningEffortSetting) || "default",
    );
    return reasoningEffort === "default"
      ? defaults.reasoningEffort || "default"
      : reasoningEffort;
  }

  private static endpointCoreEquals(a: LLMEndpoint, b: LLMEndpoint): boolean {
    const codexFieldsEqual =
      a.providerType !== "codex-app-server" ||
      (a.codexRole === b.codexRole &&
        a.codexBinaryPath === b.codexBinaryPath &&
        JSON.stringify(a.approvalPolicy) === JSON.stringify(b.approvalPolicy) &&
        JSON.stringify(a.sandboxPolicy) === JSON.stringify(b.sandboxPolicy) &&
        a.networkAccess === b.networkAccess &&
        a.mcpEnabled === b.mcpEnabled);
    const claudeFieldsEqual =
      a.providerType !== "claude-code-cli" ||
      (a.claudeBinaryPath === b.claudeBinaryPath &&
        a.claudePermissionMode === b.claudePermissionMode &&
        a.claudeRestricted === b.claudeRestricted &&
        a.claudeOutputFormat === b.claudeOutputFormat);
    return (
      a.id === b.id &&
      a.name === b.name &&
      a.providerType === b.providerType &&
      a.apiUrl === b.apiUrl &&
      a.apiKey === b.apiKey &&
      a.model === b.model &&
      a.reasoningEffort === b.reasoningEffort &&
      a.codingPlanVendor === b.codingPlanVendor &&
      a.codingPlanProfile === b.codingPlanProfile &&
      (a.pdfProcessMode || "global") === (b.pdfProcessMode || "global") &&
      a.enabled === b.enabled &&
      codexFieldsEqual &&
      claudeFieldsEqual
    );
  }
}

export default LLMEndpointManager;
