# @nexa/system-host

Perry native library for the **Nexa System Host** (ADR-005).

The System Host exposes the typed `CommandResult`/`NexaError` mappers and the
`nexa_result_json_v1` codec used by new FFI commands. Clipboard v1 symbols run
through the System Task worker and completion queue; the original clipboard
symbols remain legacy sentinel adapters for compatibility only. UI stays in
`@nexa/nui-host`.

File dialogs are exposed by `@nexa/dialog`. `OpenFileDialog` and
`SaveFileDialog` run on the System worker pool, settle through `AwaitTask`, and
return `null` for user cancellation. The native backend is `rfd::FileDialog`;
tests inject `nui_system_core::DialogBackend` instead of opening a real picker.
The `rfd` synchronous API exposes only `Option<PathBuf>`, so the native backend
currently has no `PLATFORM_FAILURE` return path. Dialog Task cancellation and
owner invalidation discard late delivery but cannot actively close a picker
that is already visible.

Application capabilities are declared by the strict JSON v1 manifest described
in `docs/decisions/ADR-011-app-manifest-permission-loader-v1.md`. The native
launcher must load a development file or packaged bytes with
`nui_system_core::{load_development_manifest, load_release_manifest}` and call
the Rust-only `install_app_manifest` entry point exactly once. The process is
deny-all until that trusted installation succeeds; TypeScript cannot grant,
reload, or select a manifest path.
