# Coding Plan Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add maintainable Kimi Code, GLM Coding Plan, and restricted Claude Code CLI integrations to AI Butler without regressing existing providers or the Codex Sol/Luna queue gate.

**Architecture:** Keep `LLMEndpoint.providerType` as the transport discriminator. Kimi and GLM are explicit profiles over the existing OpenAI-compatible transport; Claude Code is a separate local CLI provider with an injectable process/stream adapter. All three remain text/MinerU-only, MCP-off by default, and subject to the existing Sol/Luna ledger and note-write gate.

**Tech Stack:** TypeScript, Zotero HTTP/Subprocess APIs, OpenAI Chat Completions, Claude Code `stream-json`, Zotero preferences, Mocha/Chai, existing `zotero-plugin` build/test scripts.

**Spec:** `docs/superpowers/specs/2026-08-28-coding-plan-providers-design.md`

## Global Constraints

- Existing OpenAI, OpenAI-compatible, Gemini, Anthropic, OpenRouter, Volcano Ark, Ollama, and Codex App Server endpoints must remain usable.
- Kimi/GLM profiles use API keys only for HTTP requests; no key enters logs, ledger, metadata, or CLI arguments.
- Claude Code CLI uses `-p --output-format stream-json --permission-mode plan --restricted --no-session-persistence --max-turns 1 --no-chrome`; unsupported CLI capabilities fail closed.
- All Coding Plan providers use extracted text/MinerU and reject Base64 PDF, images, raw files, and MCP by default.
- Sol uses `gpt-5.6-sol/high` for planning and independent acceptance; Luna uses `gpt-5.6-luna/max` for bounded execution; no provider bypasses the note-write gate.
- Do not modify `/Users/alater/Zotero`, installed XPI, user credential files, or the remote repository.
- Every implementation task ends with focused tests, a commit, and a scoped review before the next task.

---

### Task 1: Coding Plan profile catalog and endpoint schema

**Files:**

- Create: `src/modules/codingPlanProfiles.ts`
- Modify: `src/modules/apiKeyManager.ts`
- Modify: `src/modules/llmEndpointManager.ts`
- Modify: `src/modules/llmproviders/types.ts`
- Modify: `addon/prefs.js`
- Modify: `typings/prefs.d.ts`
- Test: `test/codingPlanProfiles.test.ts`
- Test: `test/llmEndpointManager.test.ts`

**Interfaces:**

- Produces `CodingPlanVendor`, `CodingPlanProtocol`, `CodingPlanProfile`, `getCodingPlanProfile(id)`, and `listCodingPlanProfiles()`.
- `LLMEndpoint` gains optional `codingPlanVendor?: CodingPlanVendor` and `codingPlanProfile?: string`; legacy JSON without them normalizes unchanged.
- `ProviderId` gains `claude-code-cli`; Kimi/GLM remain `openai-compat` transport endpoints with profile metadata.

- [ ] **Step 1: Write failing profile tests.** Assert exact IDs, labels, default URLs/models, `supportsPdfBase64 === false`, Kimi/GLM API-key requirements, Claude CLI no-API-key requirement, and unknown-profile rejection.
- [ ] **Step 2: Run `npx mocha --config test/tsconfig.json test/codingPlanProfiles.test.ts test/llmEndpointManager.test.ts` and record the expected missing-symbol failures.**
- [ ] **Step 3: Implement the immutable profile catalog and endpoint normalization.** Use `kimi-for-coding` and `glm-5.3` defaults, preserve user-saved model/URL/key, add Claude CLI fields without changing existing provider defaults, and keep Codex outside API-key rotation.
- [ ] **Step 4: Add migration tests.** Verify old endpoint JSON round-trips, profile fields persist, Kimi/GLM empty keys are invalid, and Claude CLI is usable with a non-empty binary/model configuration.
- [ ] **Step 5: Run focused tests, TypeScript, targeted lint/Prettier, then commit.**

```bash
git add src/modules/codingPlanProfiles.ts src/modules/apiKeyManager.ts src/modules/llmEndpointManager.ts src/modules/llmproviders/types.ts addon/prefs.js typings/prefs.d.ts test/codingPlanProfiles.test.ts test/llmEndpointManager.test.ts
git commit -m "feat: add coding plan provider profiles"
```

---

### Task 2: Kimi Code and GLM HTTP transport profiles

**Files:**

- Modify: `src/modules/llmService.ts`
- Modify: `src/modules/llmproviders/OpenAICompatProvider.ts`
- Modify: `src/modules/llmproviders/AnthropicProvider.ts` only if an Anthropic profile normalization path is required by tests
- Test: `test/codingPlanHttpProviders.test.ts`
- Test: `test/llmProviders.test.ts`

**Interfaces:**

- Consumes Task 1 `codingPlanVendor`/profile metadata and existing `LLMOptions`.
- Produces provider-specific option normalization without new duplicated HTTP clients.

- [ ] **Step 1: Write failing payload tests.** For Kimi OpenAI mode assert full endpoint, Bearer key, `kimi-for-coding` default, K3-only reasoning behavior, streaming deltas, and no Base64. For GLM assert full endpoint, Bearer key, `glm-5.3` default, no unsupported reasoning/MCP fields, and clear 401/429 mapping.
- [ ] **Step 2: Run the focused tests and verify profile-specific assertions fail before implementation.**
- [ ] **Step 3: Implement profile-aware option normalization.** Map profile defaults only when the endpoint field is empty; send only supported parameters; keep existing OpenAI-compatible behavior byte-for-byte for endpoints without a Coding Plan profile.
- [ ] **Step 4: Implement/verify provider error classification.** Add stable vendor/error codes for unauthorized, quota/rate-limit, unsupported parameter, timeout, and malformed response; redact request keys and bodies in reports.
- [ ] **Step 5: Run focused provider tests, all existing provider tests, `npm run i18n:check`, tsc, lint, and build; commit.**

```bash
git add src/modules/llmService.ts src/modules/llmproviders/OpenAICompatProvider.ts src/modules/llmproviders/AnthropicProvider.ts test/codingPlanHttpProviders.test.ts test/llmProviders.test.ts
git commit -m "feat: support Kimi and GLM coding plan transports"
```

---

### Task 3: Restricted Claude Code CLI runtime and Provider

**Files:**

- Create: `src/modules/llmproviders/claudeCodeCli/types.ts`
- Create: `src/modules/llmproviders/claudeCodeCli/ClaudeCodeCliProcess.ts`
- Create: `src/modules/llmproviders/ClaudeCodeCliProvider.ts`
- Modify: `src/modules/llmproviders/types.ts`
- Modify: `src/modules/llmproviders/index.ts`
- Modify: `src/hooks.ts`
- Test: `test/claudeCodeCliProvider.test.ts`

**Interfaces:**

- `ClaudeCodeCliProcess.spawn(options)` resolves an absolute `claude` executable and exposes `write`, `onLine`, `onExit`, `kill`, and `getDiagnostics`.
- `ClaudeCodeCliProvider` implements `ILlmProvider`, rejects Base64, runs one text turn, parses `stream-json`, forwards assistant deltas, and returns final text.
- `LLMOptions` gains optional `claudeBinaryPath`, `claudePermissionMode`, `claudeRestricted`, and `claudeOutputFormat` fields.

- [ ] **Step 1: Write fake-process tests first.** Assert exact safe arguments (`-p`, `--output-format stream-json`, `--permission-mode plan`, `--restricted`, `--no-session-persistence`, `--max-turns 1`, `--no-chrome`), stdin framing, assistant delta extraction, final result parsing, and no prompt echo in diagnostics.
- [ ] **Step 2: Run `npx mocha --config test/tsconfig.json test/claudeCodeCliProvider.test.ts` and confirm the missing runtime fails.**
- [ ] **Step 3: Implement the injectable process and stream-json parser.** Use Zotero Subprocess only; do not use Node child-process APIs. Reject unsupported permission/MCP settings before spawn, drain stderr, propagate exit codes, and kill on abort/timeout.
- [ ] **Step 4: Register the provider and clean it on shutdown.** Keep each CLI invocation task-scoped; no session persistence and no resume across Zotero tasks.
- [ ] **Step 5: Run provider tests, existing Codex runtime tests, tsc, targeted lint/Prettier, and commit.**

```bash
git add src/modules/llmproviders/claudeCodeCli src/modules/llmproviders/ClaudeCodeCliProvider.ts src/modules/llmproviders/types.ts src/modules/llmproviders/index.ts src/hooks.ts test/claudeCodeCliProvider.test.ts
git commit -m "feat: add restricted Claude Code CLI provider"
```

---

### Task 4: Settings UI, bilingual copy, queue compatibility, and documentation

**Files:**

- Modify: `src/modules/views/ui/EndpointSettingsPanel.ts`
- Modify: `src/modules/views/settings/ApiSettingsPage.ts`
- Modify: `src/modules/taskQueue.ts` only where provider capability checks need the new `claude-code-cli`
- Modify: `src/modules/llmNoteMetadata.ts` only for optional profile/vendor metadata
- Modify: `addon/locale/zh-CN/mainWindow.ftl`
- Modify: `addon/locale/en-US/mainWindow.ftl`
- Modify: `addon/locale/zh-CN/preferences.ftl`
- Modify: `addon/locale/en-US/preferences.ftl`
- Modify: `README.md`
- Modify: `README-EN.md`
- Modify: `docs/quick-start.md`
- Create: `docs/coding-plan-providers.md`
- Test: `test/codingPlanProviderUi.test.ts`
- Test: `test/i18nLocaleResources.test.ts`

**Interfaces:**

- Consumes the profile catalog and Provider capabilities from Tasks 1–3.
- Produces localized provider cards, validation/help text, profile metadata in notes, and no regression in Codex Sol/Luna queue behavior.

- [ ] **Step 1: Write failing UI/i18n tests.** Assert provider labels, Kimi/GLM defaults, Claude binary/permission fields, API key visibility, profile-specific help, MCP-off and PDF-text restrictions in both locales.
- [ ] **Step 2: Run the focused UI/i18n tests and confirm missing strings/controls fail.**
- [ ] **Step 3: Implement settings controls.** Keep API URL/key visible for Kimi/GLM; hide API URL/key for Claude CLI; show binary path, model, permission mode, restricted flag and connection test for Claude; preserve existing endpoint editing behavior.
- [ ] **Step 4: Integrate optional profile/vendor metadata into note metadata and queue diagnostics without changing Sol/Luna gate semantics.**
- [ ] **Step 5: Write the bilingual documentation.** Explain vendor endpoints, model IDs, API-key handling, Claude login/CLI limits, Zhipu Coding Plan qualification uncertainty, PDF text-only behavior, MCP-off default, troubleshooting and rollback.
- [ ] **Step 6: Run i18n, UI tests, tsc, full lint, build, and commit.**

```bash
git add src/modules/views/ui/EndpointSettingsPanel.ts src/modules/views/settings/ApiSettingsPage.ts src/modules/taskQueue.ts src/modules/llmNoteMetadata.ts addon/locale README.md README-EN.md docs/quick-start.md docs/coding-plan-providers.md test/codingPlanProviderUi.test.ts test/i18nLocaleResources.test.ts
git commit -m "feat: expose coding plan providers in settings"
```

---

### Task 5: Full verification and credential-gated smoke

**Files:**

- Test: complete repository suite and temporary smoke files outside committed source
- Update: `docs/superpowers/sdd` report and external redacted verification record

- [ ] **Step 1: Run static/build gates.**

```bash
npm run lint:check
npm run build
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero ZOTERO_PLUGIN_KILL_COMMAND=true npm test
```

- [ ] **Step 2: Verify installed CLIs read-only.** Check `codex login status`, `claude --version`/`claude doctor`, and `kimi --version` if present; never print credentials or config files.
- [ ] **Step 3: Run credential-gated HTTP smoke.** Only when the user has supplied/configured Kimi or GLM credentials locally, test one short text request and record status/model/error code without keys or prompt text.
- [ ] **Step 4: Run credential-gated Claude CLI smoke.** Only when a local Claude binary and authorized session exist, run one short text request with restricted flags and verify no file/MCP side effect.
- [ ] **Step 5: Run failure checks.** Exercise Base64 rejection, 401/429 classification, timeout/abort, and route fallback with fake providers; prove Codex queue and note gate remain unchanged.
- [ ] **Step 6: Record exact counts, commits, unverified vendor credentials, rollback path, and current branch state.** Do not push or install the XPI.

## Final acceptance checklist

- [ ] Kimi Code and GLM Coding Plan profiles save and route through the correct HTTP protocol without API-key leakage.
- [ ] Claude Code CLI runs only with restricted non-interactive flags and has tested cancellation/timeout/process cleanup.
- [ ] Existing providers and Codex Sol/Luna queue tests pass.
- [ ] Base64/image/MCP fail-closed rules hold for all new providers.
- [ ] UI and documentation distinguish protocol compatibility from subscription entitlement.
- [ ] Full lint, i18n, build, and Zotero harness pass; live vendor smoke is recorded as PASS or explicitly NOT RUN per credential availability.
- [ ] No production Zotero data, installed XPI, credentials, or remote branch changed.
