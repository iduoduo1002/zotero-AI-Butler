import type { LLMAbortSignal } from "../types";

/**
 * The deliberately small process surface consumed by the Claude provider.
 * Keeping this interface independent from Zotero makes cancellation and
 * stream parsing deterministic in unit tests without introducing Node's
 * child_process API into the add-on.
 */
export interface ClaudeCodeCliProcessLike {
  write(data: string): void | Promise<void>;
  /** Signal EOF after the one text prompt has been written. */
  closeStdin?(): void | Promise<void>;
  onLine(listener: (line: string) => void): void | (() => void);
  onExit(listener: (code?: number) => void): void | (() => void);
  kill(): void | Promise<void>;
  getDiagnostics?(redactions?: readonly string[]): string;
}

/** Options accepted by the process adapter; all values are allowlisted. */
export type ClaudeCodeCliProcessOptions = {
  claudeBinaryPath?: string;
  /** Backward-compatible alias for callers using a shorter option name. */
  binaryPath?: string;
  claudePermissionMode?: "plan";
  claudeRestricted?: boolean;
  claudeOutputFormat?: "stream-json";
};

export type ClaudeCodeCliProcessFactory = (
  options: ClaudeCodeCliProcessOptions,
  abortSignal?: LLMAbortSignal,
) => ClaudeCodeCliProcessLike | Promise<ClaudeCodeCliProcessLike>;

export type ClaudeCodeCliErrorCode =
  | "claude-cli-invalid-options"
  | "claude-cli-unsupported-flags"
  | "claude-cli-process-exit"
  | "claude-cli-result-error"
  | "claude-cli-malformed-response"
  | "claude-cli-empty-response"
  | "claude-cli-timeout"
  | "claude-cli-aborted"
  | "claude-cli-unsupported-output";

export type ClaudeCodeCliError = Error & {
  code?: ClaudeCodeCliErrorCode;
  exitCode?: number;
};
