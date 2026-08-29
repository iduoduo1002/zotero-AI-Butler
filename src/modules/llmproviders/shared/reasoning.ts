import type { LLMReasoningEffort, LLMReasoningEffortSetting } from "../types";

const VALID_REASONING_EFFORTS = new Set<string>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type ReasoningNormalizationOptions = {
  /** Codex App Server accepts a higher effort than legacy API providers. */
  allowMax?: boolean;
};

export function normalizeReasoningEffortSetting(
  value: unknown,
  fallback: LLMReasoningEffortSetting = "default",
  options: ReasoningNormalizationOptions = {},
): LLMReasoningEffortSetting {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  if (raw === "auto" || raw === "inherit" || raw === "default") {
    return "default";
  }
  if (raw === "max" && options.allowMax) return "max";
  if (VALID_REASONING_EFFORTS.has(raw)) {
    return raw as LLMReasoningEffort;
  }
  return fallback;
}

export function resolveReasoningEffort(
  value: unknown,
  options: ReasoningNormalizationOptions = {},
): LLMReasoningEffort | undefined {
  const setting = normalizeReasoningEffortSetting(value, "default", options);
  return setting === "default" ? undefined : setting;
}

export function isOpenAIReasoningModel(model: string): boolean {
  const id = model
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
  return (
    /^gpt-5(?:[.-]|$)/.test(id) ||
    /^o\d(?:[.-]|$)/.test(id) ||
    /^codex(?:[.-]|$)/.test(id)
  );
}

export function resolveOpenAIReasoningEffort(
  model: string,
  value: unknown,
): LLMReasoningEffort | undefined {
  const effort = resolveReasoningEffort(value);
  if (!effort || !isOpenAIReasoningModel(model)) return undefined;

  if (/^gpt-5-pro(?:[.-]|$)/i.test(model.trim())) {
    return "high";
  }

  return effort;
}

export function resolveOpenRouterReasoningEffort(
  value: unknown,
): LLMReasoningEffort | undefined {
  return resolveReasoningEffort(value);
}
