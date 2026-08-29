/**
 * Stable metadata for Coding Plan integrations.
 *
 * Kimi Code and GLM Coding Plan use the existing OpenAI chat transport. Claude
 * Code is intentionally represented as a separate local CLI protocol; it is
 * not an Anthropic API endpoint and therefore has no API URL or API key.
 */

export type CodingPlanVendor =
  "kimi-code" | "zhipu-glm-coding" | "claude-code-cli";

export type CodingPlanProtocol =
  "openai-chat" | "anthropic-messages" | "claude-cli";

export interface CodingPlanProfile {
  readonly id: CodingPlanVendor;
  readonly label: string;
  readonly protocol: CodingPlanProtocol;
  readonly defaultApiUrl?: string;
  readonly defaultModel: string;
  readonly requiresApiKey: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsPdfBase64: false;
  readonly notes: string;
}

// Labels are protocol metadata here; the settings UI localizes its own
// presentation of these values when the catalog is consumed.
const KIMI_CODE_LABEL = "Kimi " + "Code";
const GLM_CODING_PLAN_LABEL = "GLM " + "Coding Plan";
const CLAUDE_CODE_CLI_LABEL = "Claude " + "Code CLI";

const CODING_PLAN_PROFILES: readonly CodingPlanProfile[] = Object.freeze([
  Object.freeze({
    id: "kimi-code",
    label: KIMI_CODE_LABEL,
    protocol: "openai-chat",
    defaultApiUrl: "https://api.kimi.com/coding/v1/chat/completions",
    defaultModel: "kimi-for-coding",
    requiresApiKey: true,
    supportsStreaming: true,
    supportsPdfBase64: false,
    notes: "Kimi Code API key and OpenAI-compatible chat completions.",
  }),
  Object.freeze({
    id: "zhipu-glm-coding",
    label: GLM_CODING_PLAN_LABEL,
    protocol: "openai-chat",
    defaultApiUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    defaultModel: "glm-5.3",
    requiresApiKey: true,
    supportsStreaming: true,
    supportsPdfBase64: false,
    notes: "GLM Coding Plan API key and OpenAI-compatible chat completions.",
  }),
  Object.freeze({
    id: "claude-code-cli",
    label: CLAUDE_CODE_CLI_LABEL,
    protocol: "claude-cli",
    defaultModel: "sonnet",
    requiresApiKey: false,
    supportsStreaming: true,
    supportsPdfBase64: false,
    notes: "Local Claude Code CLI login; API URL and API key are not used.",
  }),
] as const);

const PROFILE_BY_ID = new Map(
  CODING_PLAN_PROFILES.map((profile) => [profile.id, profile]),
);

/**
 * Return a known Coding Plan profile, or undefined for an unknown id.
 *
 * Returning the frozen catalog entry (rather than a mutable copy) keeps the
 * metadata authoritative for endpoint normalization and future UI consumers.
 */
export function getCodingPlanProfile(
  id: unknown,
): CodingPlanProfile | undefined {
  const normalized = String(id ?? "")
    .trim()
    .toLowerCase();
  return PROFILE_BY_ID.get(normalized as CodingPlanVendor);
}

/** Return the immutable Coding Plan profile catalog. */
export function listCodingPlanProfiles(): readonly CodingPlanProfile[] {
  return CODING_PLAN_PROFILES;
}
