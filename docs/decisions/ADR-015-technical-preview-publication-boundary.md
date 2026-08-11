# ADR-015: Technical Preview Publication Boundary

- Status: Accepted
- Date: 2026-08-09
- Deciders: `@baicie`

## Context

The Desktop Technical Preview needs a reproducible install surface, but the
native Host crates and framework adapters are not yet stable public APIs. The
current workspace also uses source packages and local Cargo paths during
development. Publishing those paths as-is would produce tarballs that compile
only inside this repository.

## Decision

Use an npm-first Technical Preview boundary described by
[`release/packages.json`](../../release/packages.json):

- Public user packages are `@nexa/cli`, `@nexa/ui`, `@nexa/adapter-solid`,
  `@nexa/fs`, `@nexa/dialog`, and `@nexa/clipboard`. `@nexa/adapter-solid`
  is the sole Tier-1 Adapter for this Preview. Its public
  contract is limited to the Solid universal renderer and JSX runtime exports
  recorded in its package manifest.
- `@nexa/protocol`, `@nexa/nui-host`, and `@nexa/system-host` are public
  runtime-support packages because they are required by the user package
  dependency closure. They are not a supported application-level API.
- `@nexa/adapter-react`, `@nexa/adapter-vue`, `@nexa/compiler-svelte`, and
  `@nexa/system` remain private candidates.
- No standalone Rust crate is public in this Preview. Host packages receive a
  deterministic, self-contained vendored native source closure during release
  staging, including Cargo manifests, lockfiles, build scripts, protocol and
  runtime sources.
- The CLI publishes the `nexa` executable only. Its internal JavaScript module
  exports are not a compatibility promise.

This decision freezes the local packaging boundary and records the Tier-1
selection already exercised by the Solid Notes core slice. It does not authorize registry
publication, application signing, or notarization. Those actions remain separately gated by
the roadmap and release owner.

## Consequences

Published packages will contain generated `dist` JavaScript and declaration
files, while the workspace continues to use source imports for development.
Native closure staging increases package size, but prevents Cargo path escape and
keeps the Rust implementation private until its API and release process are
ready. A later decision may replace vendoring with a versioned public crate DAG.

## Verification

`tools/release-packages.test.mjs` is the source-of-truth contract for the nine
public packages, four private packages, the no-standalone-crate rule, and the
dependency boundary. `tools/solid-notes-e2e.test.mjs` proves the selected Solid
path mounts the Notes core slice, drives semantic Focus/SetValue/Invoke actions,
completes save, and releases its lifecycle. Neither local test is registry,
signed-artifact, or hosted-platform evidence.
