# Task 6 report

## Change

`CodexAppServerProcess.spawn()` now passes a restricted macOS `PATH` to
Zotero `Subprocess.call()` when launching Codex. It prepends the verified
Node installation directories `/usr/local/bin` and `/opt/homebrew/bin`,
preserves inherited PATH entries, and leaves non-macOS behavior unchanged.
No shell, `child_process`, credentials, or other providers are involved.

## Test-first evidence

Added a fake `Subprocess` test asserting that the launch environment contains
both macOS directories and preserves `/gui/bin`.

## Verification

- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- `npm test`: blocked before tests by the local harness reporting `No Zotero Found`.

## Follow-up safety fix

The macOS environment override now sets `environmentAppend: true`, so Zotero
retains inherited variables such as `HOME` and `CODEX_HOME`. A non-macOS
regression test confirms no environment override is sent.

## Remaining limitation

The full Zotero-backed focused test cannot run until a Zotero binary is
configured for the test harness.
