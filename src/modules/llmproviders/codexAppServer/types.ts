import type { LLMAbortSignal, LLMReasoningEffort } from "../types";

/** A minimal process surface shared by Zotero and test doubles. */
export interface CodexAppServerProcessLike {
  write(line: string): void | Promise<void>;
  onLine(listener: (line: string) => void): void | (() => void);
  onExit(listener: (code?: number) => void): void | (() => void);
  kill(): void | Promise<void>;
  getDiagnostics?(): string;
}

export type CodexAppServerEvent = {
  id?: number;
  method: string;
  params?: unknown;
};

/** Stable app-server approval values accepted by Codex's generated schema. */
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

export type CodexSandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

/** Deliberately small diagnostics that never contain prompt or document text. */
export type CodexEventDiagnostic = {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  status?: string;
  type?: string;
};

export type CodexTurnResult = {
  threadId: string;
  turnId: string;
  text: string;
  diagnostics: CodexEventDiagnostic[];
  /** Alias retained for callers that refer to streamed events as events. */
  events: CodexEventDiagnostic[];
};

export type CodexAppServerRunTurnParams = {
  model: string;
  reasoningEffort: LLMReasoningEffort | string;
  input: string;
  executionId: string;
  parentExecutionId?: string;
  role?: "sol" | "luna";
  threadId?: string;
  abortSignal?: LLMAbortSignal;
  onEvent?: ((event: CodexAppServerEvent) => void | Promise<void>) | undefined;
  /** Optional per-turn deadline. The client default is intentionally bounded. */
  timeoutMs?: number;
  approvalPolicy?: string | Record<string, unknown>;
  sandboxPolicy?: string | Record<string, unknown>;
  networkAccess?: boolean;
  mcpEnabled?: boolean;
};

export type CodexAppServerProcessOptions = {
  codexBinaryPath?: string;
  /** Backward-compatible alias for callers using a shorter option name. */
  binaryPath?: string;
};

export type CodexAppServerClientOptions = {
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
};
