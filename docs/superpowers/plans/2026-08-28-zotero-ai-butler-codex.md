# Zotero AI Butler Codex App Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native `codex-app-server` Provider to the forked AI Butler so queued Zotero summary/deep-read jobs can run through the local Codex App Server with auditable Sol/Luna execution metadata.

**Architecture:** Preserve all existing HTTP Providers and the `ILlmProvider` facade. Add an injectable stdio JSONL Codex runtime (process → JSON-RPC client → Provider), then thread an execution context through endpoint routing, note generation, and the task ledger. The first production path uses text/MinerU content, one turn per task, local process lifecycle, and explicit Sol/Luna role defaults; broad Zotero MCP writes remain disabled.

**Tech Stack:** TypeScript, Zotero Subprocess API, stdio JSONL JSON-RPC, Zotero preferences, Mocha/Chai, existing `zotero-plugin` build/test scripts.

**Spec:** `docs/superpowers/specs/2026-08-28-zotero-ai-butler-codex-design.md`

## Global Constraints

- Existing OpenAI-compatible, OpenAI Responses, Gemini, Anthropic, OpenRouter, Volcano Ark, and Ollama Providers must remain usable.
- Codex calls use `codex app-server` over stdio JSONL and retain thread, turn, event, approval, and diagnostic metadata.
- Sol uses `gpt-5.6-sol` + `high` for task contracts, planning, integration, and independent acceptance; Luna uses `gpt-5.6-luna` + `max` for bounded execution.
- Codex endpoint must not require an API key and must not use Base64 PDF input in the first release; use text/MinerU content.
- Default queue concurrency remains 1 and a single Codex process must not receive concurrent turns.
- Never modify `/Users/alater/Zotero` or replace an installed XPI during implementation; all changes stay in `codex/codex-app-server`.
- Do not log API keys, bearer tokens, PDF Base64, full PDF text, or absolute local paths.
- A failed Sol acceptance or failed artifact probe must prevent final-note write.
- Every task ends with focused tests and a commit; every task is reviewed before the next task starts.

---

### Task 1: Codex App Server runtime and Provider

**Files:**
- Create: `src/modules/llmproviders/codexAppServer/types.ts`
- Create: `src/modules/llmproviders/codexAppServer/CodexAppServerProcess.ts`
- Create: `src/modules/llmproviders/codexAppServer/CodexAppServerClient.ts`
- Create: `src/modules/llmproviders/CodexAppServerProvider.ts`
- Modify: `src/modules/llmproviders/types.ts`
- Modify: `src/modules/llmproviders/index.ts`
- Test: `test/codexAppServerProvider.test.ts`

**Interfaces:**
- Consumes existing `ILlmProvider`, `LLMOptions`, `ConversationMessage`, `ProgressCb`, and the Zotero runtime.
- Produces `CodexAppServerClient`, `CodexAppServerProcess`, and a self-registered Provider with id `codex-app-server`.
- `LLMOptions` gains optional `executionId`, `parentExecutionId`, `role: "sol" | "luna"`, `codexBinaryPath`, `approvalPolicy`, `sandboxPolicy`, `networkAccess`, `mcpEnabled`, and `codexThreadId` fields. Existing Provider callers may omit them.
- `CodexAppServerClient.runTurn(params): Promise<CodexTurnResult>` accepts `model`, `reasoningEffort`, `input`, `executionId`, optional `threadId`, `abortSignal`, and `onEvent`; it returns `threadId`, `turnId`, `text`, and redacted event diagnostics.

- [ ] **Step 1: Write protocol tests first.** Add a fake line-oriented subprocess with stdin capture and stdout lines. Assert `initialize` is sent before `thread/start`, request ids are matched out of order, `item/agentMessage/delta` chunks are concatenated, and `turn/completed` resolves the turn.

~~~ts
it("runs initialize, thread/start, and turn/start and streams final text", async () => {
  const fake = new FakeJsonlProcess([
    { id: 1, result: { userAgent: "fake" } },
    { id: 2, result: { thread: { id: "thr-1" } } },
    { method: "item/agentMessage/delta", params: { delta: "摘要" } },
    { id: 3, result: { turn: { id: "turn-1" } } },
    { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
  ]);
  const result = await new CodexAppServerClient(fake).runTurn({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: "请输出摘要",
    executionId: "exec-1",
  });
  expect(result.text).to.equal("摘要");
  expect(fake.requests.map((r) => r.method)).to.deep.equal([
    "initialize", "thread/start", "turn/start",
  ]);
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails** with the missing runtime/client symbols.

~~~bash
npx mocha --config test/tsconfig.json test/codexAppServerProvider.test.ts
~~~

Expected: FAIL because the new Codex runtime is not implemented.

- [ ] **Step 3: Implement the smallest protocol layer.** Use an injectable process interface (`write(line)`, `onLine(cb)`, `onExit(cb)`, `kill()`) so tests do not need Zotero. Serialize JSON-RPC lines, maintain a numeric request id map, reject pending requests on process exit, and redact diagnostics before exposing them.

- [ ] **Step 4: Implement cancellation and timeout tests.** Assert an aborted signal sends `turn/interrupt`, rejects with an abort error, and kills only the task process after the timeout. Assert a non-completed terminal status rejects with a message containing the turn id but not input text.

- [ ] **Step 5: Implement `CodexAppServerProvider`.** `generateSummary` and `chat` must reject `isBase64 === true`, build a text prompt from existing prompt helpers, call `runTurn`, stream each delta through `onProgress`, and return only final assistant text. `testConnection` must perform a real minimal turn with `Say OK`, using `gpt-5.6-sol`/`high` defaults when no model/effort is supplied.

- [ ] **Step 6: Register and run tests.** Export the Provider from `index.ts`, keep existing provider registrations unchanged, run the focused test plus `test/llmProviders.test.ts`, and commit:

~~~bash
git add src/modules/llmproviders test/codexAppServerProvider.test.ts
git commit -m "feat: add native Codex app-server provider"
~~~

---

### Task 2: Endpoint model, preferences, and settings UI

**Files:**
- Modify: `src/modules/apiKeyManager.ts`
- Modify: `src/modules/llmEndpointManager.ts`
- Modify: `src/modules/views/ui/EndpointSettingsPanel.ts`
- Modify: `addon/prefs.js`
- Modify: `addon/locale/zh-CN/mainWindow.ftl`
- Modify: `addon/locale/en-US/mainWindow.ftl`
- Modify: `addon/locale/zh-CN/preferences.ftl`
- Modify: `addon/locale/en-US/preferences.ftl`
- Test: `test/llmEndpointManager.test.ts`
- Test: `test/i18nLocaleResources.test.ts`

**Interfaces:**
- Consumes Provider id `codex-app-server` and the `LLMOptions` Codex fields from Task 1.
- Produces normalized `LLMEndpoint` values with `providerType: "codex-app-server"`, empty `apiUrl/apiKey`, `model`, `reasoningEffort`, `codexRole`, `codexBinaryPath`, `approvalPolicy`, `sandboxPolicy`, `networkAccess`, and `mcpEnabled`.
- `LLMEndpointManager.isEndpointUsable` returns true for Codex when model is non-empty even though URL/key are empty.

- [ ] **Step 1: Add failing normalization tests.** Cover provider enumeration, Sol defaults (`gpt-5.6-sol` + `high`), Luna defaults (`gpt-5.6-luna` + `max`), empty-key usability, migration of unknown stored provider values, and default `pdfProcessMode: "text"` for Codex.

- [ ] **Step 2: Run the focused endpoint tests and verify the new cases fail.**

~~~bash
npx mocha --config test/tsconfig.json test/llmEndpointManager.test.ts
~~~

- [ ] **Step 3: Implement endpoint type/default/migration changes.** Keep legacy endpoint migration behavior intact. Do not add Codex to `ApiKeyManager` rotation maps; Codex has no API keys.

- [ ] **Step 4: Add UI controls.** In `EndpointSettingsPanel`, render a Codex-specific section that hides API URL/key, exposes binary path, Sol/Luna role, model, reasoning effort, approval policy, sandbox policy, network access, and an explicitly off-by-default MCP checkbox. Changing role updates model/effort defaults only when the user has not customized them. Connection test calls `LLMService.testEndpointConnection` and displays the returned real-turn result.

- [ ] **Step 5: Add matching Chinese and English Fluent strings and preference defaults.** Run both i18n tests; every new message id must exist in both locales.

- [ ] **Step 6: Commit the settings slice.**

~~~bash
git add src/modules/apiKeyManager.ts src/modules/llmEndpointManager.ts src/modules/views/ui/EndpointSettingsPanel.ts addon/prefs.js addon/locale test/llmEndpointManager.test.ts test/i18nLocaleResources.test.ts
git commit -m "feat: add Codex endpoint settings"
~~~

---

### Task 3: Execution context, task ledger, and Sol/Luna queue integration

**Files:**
- Create: `src/modules/codexTaskLedger.ts`
- Modify: `src/modules/llmService.ts`
- Modify: `src/modules/noteGenerator.ts`
- Modify: `src/modules/taskQueue.ts`
- Modify: `src/modules/taskArtifacts.ts`
- Modify: `src/modules/llmNoteMetadata.ts`
- Modify: `src/hooks.ts`
- Test: `test/codexTaskLedger.test.ts`
- Test: `test/taskQueue.codex.test.ts`
- Test: `test/llmNoteMetadata.test.ts`

**Interfaces:**
- Consumes the Codex Provider and endpoint fields from Tasks 1–2.
- Produces `CodexExecutionContext` and `CodexTaskLedger` with append-only records:

~~~ts
type CodexRole = "sol" | "luna";
type CodexExecutionStatus =
  | "planned" | "running" | "awaiting_approval" | "passed"
  | "partial" | "blocked" | "failed";
interface CodexExecutionContext {
  executionId: string;
  parentExecutionId?: string;
  role: CodexRole;
  model: string;
  reasoningEffort: string;
  itemKey?: string;
  attachmentKey?: string;
  sourceSha256?: string;
  threadId?: string;
  turnId?: string;
  approvalPolicy: string;
  sandboxPolicy: string;
  networkAccess: boolean;
}
~~~

- [ ] **Step 1: Write ledger tests first.** Assert a record receives a stable execution id, appends status transitions without exposing prompt/PDF content, survives a malformed previous line, and can query the latest record by Zotero item key.

- [ ] **Step 2: Run ledger tests and verify failure.**

~~~bash
npx mocha --config test/tsconfig.json test/codexTaskLedger.test.ts
~~~

- [ ] **Step 3: Implement an append-only JSONL ledger.** Store it under the plugin data directory, create the directory on demand, write one redacted JSON object per line, and expose `start`, `update`, `complete`, `fail`, and `findLatest` methods. Never persist full prompts, Base64, or absolute paths.

- [ ] **Step 4: Thread context through `LLMService`.** Generate an execution id per attempt, pass role/model/policy fields to `LLMOptions`, capture Provider response `threadId/turnId/requestId`, and close the ledger entry on success/failure. Existing API Provider routes must receive the same request without Codex-only fields changing behavior.

- [ ] **Step 5: Integrate queue and notes.** Keep queue concurrency 1 and existing retry semantics. For Codex endpoints, force text/MinerU content, reject Base64 before provider invocation, and mark unsupported image-summary jobs explicitly. Add execution/thread/turn/role/source hash/status metadata through `NoteGenerator`, `TaskArtifacts`, and `llmNoteMetadata`.

- [ ] **Step 6: Add Sol/Luna gating.** For a Codex batch task, create a Sol planning record, run bounded Luna work only when a contract exists, then run Sol acceptance against the generated artifact probe. Write the final Zotero note only for `PASS`; use `PARTIAL`/`BLOCKED`/`FAILED` queue states otherwise.

- [ ] **Step 7: Dispose runtime on shutdown.** Update `hooks.ts` to call the Codex process registry cleanup on plugin shutdown and test that no process remains after cancellation or shutdown.

- [ ] **Step 8: Run queue/metadata tests and commit.**

~~~bash
npx mocha --config test/tsconfig.json test/codexTaskLedger.test.ts test/taskQueue.codex.test.ts test/llmNoteMetadata.test.ts
git add src/modules/codexTaskLedger.ts src/modules/llmService.ts src/modules/noteGenerator.ts src/modules/taskQueue.ts src/modules/taskArtifacts.ts src/modules/llmNoteMetadata.ts src/hooks.ts test/codexTaskLedger.test.ts test/taskQueue.codex.test.ts test/llmNoteMetadata.test.ts
git commit -m "feat: audit Codex executions in the task queue"
~~~

---

### Task 4: Full verification, packaging, and demo evidence

**Files:**
- Modify: `README.md`
- Modify: `README-EN.md`
- Modify: `docs/quick-start.md`
- Create: `docs/codex-app-server.md`
- Test: existing complete test suite and build outputs

**Interfaces:**
- Consumes all previous task commits and the design spec.
- Produces a documented setup path, clean build, test report, and a redacted real-demo evidence file outside the plugin source tree.

- [ ] **Step 1: Run static checks and the complete test suite.**

~~~bash
npm run lint:check
npm run build
npm test
~~~

Record exact failures; do not call the branch complete on a partial suite.

- [ ] **Step 2: Verify Codex runtime prerequisites read-only.** Confirm `codex login status`, `codex app-server --help`, selected model/effort compatibility, and local binary path. Do not print auth files or tokens.

- [ ] **Step 3: Run a real smoke turn.** In a temporary Zotero profile with one authorized test PDF, create a Codex endpoint, test connection, run one summary/deep-read task, and verify execution/thread/turn ids, source SHA-256, artifact probe, and final note. Capture only redacted ids/statuses and hashes.

- [ ] **Step 4: Exercise failure paths.** Cancel one task, force one timeout/retry, and restart the temporary profile. Verify queue state and ledger status are explainable and no Codex process remains.

- [ ] **Step 5: Update documentation.** Document `codex login`, binary discovery, Sol/Luna defaults, text/MinerU limitation, MCP-off default, approval/sandbox policy, troubleshooting, and rollback. Keep claims explicit about cloud-model data residency.

- [ ] **Step 6: Commit verification documentation.**

~~~bash
git add README.md README-EN.md docs/quick-start.md docs/codex-app-server.md
git commit -m "docs: document Codex app-server setup and verification"
~~~

---

## Final acceptance checklist

- [ ] Existing Provider tests pass.
- [ ] Codex endpoint saves without API key and connection test performs a real minimal turn.
- [ ] One real summary/deep-read task completes through Codex App Server and writes a Zotero note only after Sol acceptance.
- [ ] Thread/turn/role/policy/source hash/artifact metadata is queryable and redacted.
- [ ] Interrupt, timeout, retry, and shutdown paths leave no zombie process.
- [ ] Build, lint, i18n, and complete tests pass.
- [ ] No installed XPI or production Zotero data changed during development.

