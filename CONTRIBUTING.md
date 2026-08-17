# Contributing to Nexa UI

Nexa UI is in Desktop Technical Preview development. Changes should follow the
dependency order and acceptance criteria in `docs/PROJECT-DESIGN.md`,
`docs/ROADMAP.md`, and `TODO.md`.

## Development setup

Use Node.js 22 or newer, pnpm 10.34.3, Rust 1.88, and the Perry version pinned
in the root package. Install dependencies with `pnpm install --frozen-lockfile`.

Before opening a pull request, run the checks owned by the changed paths. The
complete local gate is:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
git diff --check
```

Platform, FFI, Perry, and package changes must also pass their required GitHub
Actions jobs. A workflow definition is not evidence that a hosted job passed;
record the run and job links required by the corresponding TODO acceptance.

## Change process

1. Open an issue or discussion for behavioral changes, new dependencies,
   protocol changes, public API changes, or release policy changes.
2. Update the governing ADR/spec before changing a frozen contract.
3. Add a failing regression or contract test before changing behavior.
4. Keep each pull request focused on one verifiable vertical slice.
5. Update public documentation, compatibility notes, and TODO evidence in the
   same pull request.

Do not include secrets, generated build directories, private registry tokens,
or user data. Use injected backends and task-owned temporary directories for
tests that would otherwise modify system state.

## Developer Certificate of Origin

Contributions use the Developer Certificate of Origin 1.1. Add a sign-off to
each commit with `git commit -s`; the sign-off certifies that you have the right
to submit the contribution under the repository's MIT OR Apache-2.0 license.

## Review and release

`@baicie` is the current repository and release owner. Approval does not replace
required CI. Publishing packages, signing applications, changing branch
protection, or using release credentials requires the release owner's explicit
approval and the release rehearsal defined by the roadmap.
