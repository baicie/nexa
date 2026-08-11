# ADR-013: Dialog Task and Backend v1

- Status: Accepted (Desktop Notes MVP)
- Date: 2026-08-07
- Scope: G4-06 `@nexa/dialog` open/save file dialogs

## Context

Notes needs a file picker, but a modal platform dialog must not block the Nexa UI
thread or bypass the System Task owner fence. Perry FFI v0.5 also cannot safely
receive arbitrary TypeScript object shapes, so dialog options need an explicit
wire representation.

## Decision

1. `system.OpenFileDialog` and `system.SaveFileDialog` are versioned System
   commands. Both start a `common.Task` and settle through the existing
   `AwaitTask`/`SystemCompletion` path.
2. The FFI start functions take three UTF-8 strings: title, default path, and a
   JSON array of `{name, extensions}` filters. The typed `@nexa/dialog` package
   owns validation and serialization; the Host parser rejects unknown fields,
   empty filter names, path/title NULs, and malformed JSON.
3. A selected path settles as a string. User cancellation settles as
   `ok: true, value: null`; it is not a `CANCELLED` error. Explicit Task cancel,
   owner close, and runtime invalidation retain normal Task cancellation
   semantics and drop late backend results.
4. `nui-system-core::DialogBackend` is the injectable boundary. Tests use a
   deterministic backend. The System Host native backend uses `rfd::FileDialog`
   inside the existing worker executor, preserving the single UI thread rule.
5. `system.DialogOpen` and `system.DialogSave` are deny-all manifest permissions;
   they are checked before a Task identity is allocated.

## Consequences

- Notes can distinguish user cancellation from permission, platform, and input
  errors without sentinel values.
- Dialog completion, Promise settlement, owner close, wakeup, and cleanup reuse
  the tested FS Task machinery.
- Filter transport is intentionally JSON for v1; a generated structured FFI
  object is deferred until Perry supports guarded object-shape transport.

## Verification

- Protocol manifest/schema/generated Rust/TS/Perry artifacts and fixtures pass
  `pnpm test:protocol`.
- `@nexa/dialog` contract tests cover option encoding, selected path, null
  cancellation, idempotent cancel, and invalid empty paths.
- System Host dialog parser, injected backend Task settlement, late cancellation,
  `cargo test`, and strict Clippy pass.
