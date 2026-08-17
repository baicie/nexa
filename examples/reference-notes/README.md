# Desktop Notes MVP

Minimal TSX reference application for the Notes MVP. It exercises the shared
Input/TextArea controls and the typed `@nexa/dialog` and `@nexa/fs` APIs.

```bash
pnpm --filter @nexa/example-reference-notes typecheck
pnpm --filter @nexa/example-reference-notes build
pnpm --filter @nexa/example-reference-notes smoke:fs
pnpm --filter @nexa/example-reference-notes smoke:dialog
```

Native open/save execution requires a trusted app manifest with filesystem and
dialog permissions. The app keeps the current document intact when a dialog is
cancelled or a typed operation fails.

`smoke:dialog` uses a build-time injected backend to prove the native
Task/Promise/controller journey. `smoke:picker` instead compiles a fixture-free
probe and drives the real save/open/cancel panels; it requires an interactive
desktop plus macOS Accessibility or Windows desktop automation and must fail
closed when those capabilities are unavailable.

The current `rfd` native backend reports only a selected path or `None` for
cancel. It has no native `PLATFORM_FAILURE` result, and cancelling the Nexa Task
invalidates delivery without actively closing a picker that is already shown.
