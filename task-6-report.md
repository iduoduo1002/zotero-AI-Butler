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
- Bare `npm test`: the local harness reports `No Zotero Found` when no Zotero
  executable is configured.

## Follow-up safety fix

The macOS environment override now sets `environmentAppend: true`, so Zotero
retains inherited variables such as `HOME` and `CODEX_HOME`. A non-macOS
regression test confirms no environment override is sent.

The fallback implementation was lint-cleaned without changing PATH behavior.
`npm run lint:check`, `npx tsc --noEmit`, and `npm run build` all pass.

The bare-command test now asserts command, arguments, and stderr separately,
so the expected launch contract remains strict while allowing macOS PATH
environment fields. Without an explicit Zotero executable path, the harness
still reports `No Zotero Found` before running tests.

With the local Zotero executable configured, the complete harness run passed
357 tests:

```bash
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero \
ZOTERO_PLUGIN_KILL_COMMAND=true npm test -- --abort-on-fail
```

## Remaining limitation

No live vendor credential smoke was run. A production GUI connection test
still needs to be run after installing the beta4 XPI.
