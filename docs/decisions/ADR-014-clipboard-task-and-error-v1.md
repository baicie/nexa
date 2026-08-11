# ADR-014：Clipboard Task and Error v1

- Status: Accepted (Desktop Notes MVP)
- Date: 2026-08-07
- Scope: G4-07 `@nexa/clipboard` read/write migration

## Context

The original clipboard surface synchronously called native sentinel symbols:
read failures became an empty string and write failures became `false`. That
shape loses the distinction between a denied command, a cancelled task and an
OS clipboard failure, and it can block the UI thread while opening the native
clipboard provider.

## Decision

1. `system.ClipboardReadText` and `system.ClipboardWriteText` start a typed
   `common.Task` and settle through the existing `AwaitTask` and
   `SystemCompletion` path.
2. The v1 FFI symbols return `nexa_result_json_v1` envelopes containing a
   strict `HandleRef`. The old sentinel symbols remain exported only as a
   compatibility layer and are not used by `@nexa/clipboard`.
3. `@nexa/clipboard` exposes `ClipboardTask<T>` with one `result` Promise and
   idempotent `cancel()`, matching `@nexa/fs` and `@nexa/dialog`.
4. Clipboard operations run in the bounded System worker executor. A native
   backend failure maps to `PLATFORM_FAILURE` with a stable `platformCode`
   (`CLIPBOARD_UNAVAILABLE` or `CLIPBOARD_OPERATION`); manifest denial and
   task cancellation retain their own error codes.
5. `ClipboardBackend` remains the injection boundary. Contract tests use an
   in-memory backend and never read or modify the developer's real clipboard.

## Consequences

- Clipboard errors are observable and machine-discriminable by code and
  `NexaSystemError` metadata.
- Clipboard calls no longer perform blocking native work on the UI thread.
- Existing native callers can continue using the deprecated sentinel symbols
  during the private-package migration window.
- Callers must await `readText().result` or `writeText(value).result` and may
  cancel a pending operation before the owner closes.

## Verification

- `tools/clipboard-contract.test.mjs` covers v1 transport, UTF-8 values,
  structured errors, malformed handles and idempotent cancellation.
- System Host Rust tests cover injected backend success/failure and typed Task
  settlement; core tests cover the backend injection helpers.
- `cargo test --manifest-path packages/system-host/Cargo.toml --offline`,
  package typechecks, workspace tests and the native-library build must pass.
