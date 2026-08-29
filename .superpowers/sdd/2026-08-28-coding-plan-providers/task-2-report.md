# Task 2 report — Kimi Code and GLM HTTP transport profiles

## Result

Status: `DONE_WITH_CONCERNS`

Baseline: `8c1c6df` (`fix: close coding plan service boundaries`)

The shared `OpenAICompatProvider` now consumes Task 1 Coding Plan profile
metadata. Kimi Code and GLM Coding Plan use their exact profile endpoints and
model defaults, preserve explicit endpoint/model values, send Bearer keys only
as HTTP headers, and remain text/MinerU-only. Legacy OpenAI-compatible options
without profile metadata retain the existing URL normalization and payload
behavior.

Profile HTTP errors expose stable codes in the form
`coding-plan/<vendor>/<kind>`, where `kind` is `unauthorized`, `rate-limit`,
`unsupported-parameter`, `timeout`, `malformed-response`,
`unsupported-input`, or `request-failed`. Connection-test reports redact the
request body, sensitive URL query values, response headers, response bodies,
and API keys.

## Red test evidence

The brief's direct command was attempted from the repository root:

```text
npx mocha --config test/tsconfig.json test/codingPlanHttpProviders.test.ts
```

The installed Mocha CLI interpreted the test tsconfig's `extends` path from the
parent directory and failed before loading tests with `ENOENT` for
`/Users/alater/Documents/Codex/2026-08-28/tsconfig.json`.

The focused test was then bundled with esbuild and run through a minimal Node
Mocha harness. Before production changes, it reached the intended red state:

```text
1 passing, 8 failing
```

The expected failures covered empty profile defaults, the GLM full endpoint,
profile URL preservation, direct Base64 rejection, profile-specific error
codes/redaction, and profile payload normalization. The pre-existing K3
reasoning assertion passed because the unprofiled transport already sent that
field; the implementation subsequently restricted it to K3 models only for
the Kimi profile.

## Changes

- `src/modules/llmService.ts`
  - Resolves Task 1 profile metadata in `buildOptions`.
  - Fills empty Kimi/GLM URL and model fields from the immutable profile while
    preserving explicit values.
  - Supports direct profile IDs through the shared OpenAI-compatible key store
    and carries the profile metadata forward.
- `src/modules/llmproviders/OpenAICompatProvider.ts`
  - Uses exact profile endpoints; profile URLs are not rewritten with an extra
    `/v1/chat/completions` suffix.
  - Uses `kimi-for-coding` and `glm-5.3` when model input is empty.
  - Sends `reasoning_effort` only for Kimi K3 model IDs; GLM never receives it.
  - Keeps MCP/Codex-only/vendor fields out of Chat Completions payloads.
  - Rejects direct Base64 PDF inputs for profile calls, including multi-file
    Base64 parts and connection-test PDF mode.
  - Classifies unauthorized, rate-limit, unsupported-parameter, timeout, and
    malformed-response failures with stable vendor codes.
  - Redacts profile connection-test request/response diagnostics.
- `test/codingPlanHttpProviders.test.ts`
  - Adds deterministic HTTP doubles for streaming/non-streaming payloads,
    Kimi/GLM defaults, K3 reasoning, Base64 rejection, error classes, and
    secret redaction.
- `test/llmProviders.test.ts`
  - Verifies Coding Plan endpoints stay on the shared OpenAI-compatible
    provider while reporting text-only PDF capability at the service boundary.
- `.superpowers/sdd/2026-08-28-coding-plan-providers/task-2-report.md`
  - Records this scoped implementation and verification evidence.

## Verification

- Focused profile test after implementation: **9 passing**.
- Existing profile/service-boundary/endpoint/provider static regression bundle:
  **13 passing** (including the shared transport assertion).
- Official Zotero harness:

  ```text
  ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero \
  ZOTERO_PLUGIN_KILL_COMMAND=true npm test -- --abort-on-fail
  ```

  Result: **328 passed**. The run used the scaffold's temporary test profile
  and data directory; no production Zotero data was opened or changed.

- `npx tsc --noEmit`: **PASS**.
- `npm run build`: **PASS**, including built-locale consistency.
- `npm run i18n:check`: **PASS**.
- Targeted Prettier and ESLint checks for changed source/test files: **PASS**.
- Full ESLint invocation: **PASS**.
- `git diff --check`: **PASS**.
- `npx tsc --noEmit -p test/tsconfig.json`: not a usable focused gate in this
  repository; it reports the existing broad test-project TS6307 and legacy
  fixture/type diagnostics. Source `tsc --noEmit` and the actual Zotero test
  harness pass.
- `npm run lint:check`: blocked before ESLint by Prettier warnings in six
  existing `.superpowers/sdd` Markdown files outside this task's source scope
  (`progress.md`, Task 1/Task 2 briefs and reports, and the Task 4 report).
- No live Kimi/GLM credential smoke was run; API keys were not available or
  requested for this task.

## Unverified items and concerns

- Protocol behavior was verified with deterministic HTTP doubles and the full
  local Zotero harness, not against live vendor subscriptions. Profile
  presence is not treated as Coding Plan entitlement or quota confirmation.
- The shared provider's static `capabilities.supportsPdfBase64` remains true for
  legacy OpenAI-compatible callers; the endpoint/service boundary and profile
  provider methods enforce false for Coding Plan profiles. This preserves
  legacy behavior while keeping profile routing fail-closed.
- The profile error codes are intentionally stable plugin-level codes; vendor
  response codes remain available only in the redacted underlying diagnostic
  context and must not be treated as permanent vendor API contracts.

## Rollback

Revert the Task 2 commit to restore the `8c1c6df` behavior. No preferences,
credentials, installed XPI, production Zotero data, or remote branches were
modified. Disabling/removing a Coding Plan endpoint continues to leave legacy
OpenAI-compatible endpoints available.

## Commit

The final commit hash is recorded in the handoff after the report is committed.
