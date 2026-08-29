# Task 7 report: long-paper Luna timeout

## Root cause

The production failures were `Codex app-server turn timed out after 300000ms`.
The task ledger showed that Sol planning turns completed, while the Luna
worker turns were the only calls that reached the five-minute deadline. The
queue was forcing every Luna worker turn to `gpt-5.6-luna` with `max` effort.

Protocol-level synthetic probes reproduced the behavior without using user
documents: short `Say OK` turns completed for both roles; a 12,750-character
input left Luna/max running beyond 120 seconds, while Luna/high completed in
about 47 seconds. A 33,050-character input completed with Luna/high in about
69 seconds.

## Change

Codex queue metadata now explicitly sets `reasoningEffort: "high"` for Luna
worker calls. Sol planning and acceptance remain `gpt-5.6-sol` with `high`.
Direct endpoint calls keep their configured model and effort; the guard only
applies to the Sol/Luna queue execution path.

## Verification

- TDD regression assertion initially failed because the queue metadata omitted
  `reasoningEffort`; it passes after the change.
- Complete configured Zotero harness: 357 tests passed.
- `npm run lint:check`, `npx tsc --noEmit`, and `npm run build` pass on beta5.

## Remaining limitation

The fix is verified with protocol probes and the Zotero harness. A production
task retry after installing the beta5 XPI is still required for final
user-profile E2E acceptance.
