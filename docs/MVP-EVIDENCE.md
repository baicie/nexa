# Desktop Notes MVP Evidence

The MVP acceptance matrix is generated and verified against an immutable Git
revision. The record intentionally distinguishes executed local deterministic
evidence from platform or hosted blockers; a workflow configuration is not a
passing platform result.

```bash
node tools/mvp-evidence.mjs collect release/mvp-evidence.json
node tools/mvp-evidence.mjs verify release/mvp-evidence.json
```

## Schema v5

`collect` executes the canonical command for each of N-01 through N-09 as a
direct child process without a shell. It does not infer success from the case
definition. Schema v5 records the actual exit status, elapsed milliseconds,
and a bounded stdout/stderr summary for every local case. Each stream record
contains its original UTF-8 byte count, a truncation flag, and the SHA-256 of
the stored summary. A non-zero exit is retained as `failed`; collection
continues so the record shows every local result.

`verify` checks exact record keys, the canonical case order and command, the
relationship between exit status and `passed`/`failed`, and both summary
digests. It also binds the record to the requested revision. Editing a command,
status, output summary, digest, or revision invalidates the record.

The generated record contains N-01 through N-11, the exact `HEAD` revision,
the tag ref (or `WORKTREE` for a dirty checkout), and the capture timestamp.
N-10 and N-11 deliberately have no local command or execution record. Even
after their direct platform jobs have succeeded on a PR, they remain blocked in
schema v5 until a clean release-tag run uploads and promotes the required
accessibility and clean-package proofs.

## Hosted proof promotion

The manual [`mvp-evidence.yml`](../.github/workflows/mvp-evidence.yml) run is the
canonical hosted promotion path. Promotion requires a clean release tag, all
nine local commands to pass, and exactly these seven current gates to succeed
in the same GitHub Actions run, in this order:

1. TypeScript from `typescript.yml`;
2. Rust from `rust.yml`;
3. FFI from `ffi.yml`;
4. Perry frameworks from `perry-frameworks.yml`;
5. documentation from `docs.yml`;
6. native accessibility from `native-smoke.yml`;
7. clean package launch from `reference-notes-package.yml`.

Schema v5 records every gate's exact ID, producer workflow, and successful
conclusion. A missing, extra, reordered, skipped, cancelled, or failed gate,
or a result attributed to another producer, invalidates promotion. The
`promote` job runs under `if: always()` so a dependency failure reaches the
fail-closed evaluator instead of being mistaken for an absent requirement.

Each producer writes a separate hosted proof for both approved targets:

- `darwin` / `arm64` on `macos-15`;
- `win32` / `x64` on `windows-2022`.

Every platform proof records the parent and producer workflow, run ID and URL,
revision and tag, actual producer job (`smoke` or `launch`), runner, platform,
architecture, and each artifact's portable name, byte size, and SHA-256. The
accessibility proof must contain exactly the platform accessibility client. The
clean-package proof must contain exactly `generic.tar.gz` and
`reference-notes.tar.gz`, plus the canonical native runtime proof produced by
the platform `package` job. That embedded proof binds the same revision, tag,
run, runner/platform/architecture, and the byte size and SHA-256 of both the
native FS Perry binary and the fixture-free real-picker Perry binary. Its FS
journey covers invalid UTF-8 and save for N-05/N-06; its picker journey covers
save/open/cancel for N-04 and G5-04P. The proof's canonical JSON bytes are
bound again by name, size, and SHA-256 in the clean-launch proof, so changing
the semantic payload and recomputing only one digest is insufficient.

`promote-hosted` accepts exactly two regular proof files per gate, validates
their source/run/target identities, and rejects links, duplicates, missing
targets, unexpected entries, or artifact metadata drift. The schema v5 record
then embeds each platform's runner, platform, architecture, actual job and
artifact records, plus the hosted proof file name and its own SHA-256. N-10 and
N-11 can become `passed` only after both platform proofs for their gate have
validated.

Separately, `reference-notes-package.yml` is the canonical producer of the
two-archive `unsigned-signing-input` bundle. Its `signing_input` job assembles
and verifies both unsigned platform archives plus the G6-05 descriptor and
evidence. The inactive `signing.yml` path can select that exact producer run by
`unsigned_run_id`; this bundle is not a schema v5 hosted proof, a signed
artifact, or evidence that credentials were activated.

## Direct hosted execution on PR #5

GitHub Actions run `31902303937` completed 41 of 41 jobs successfully. GitHub's
run metadata identifies the PR source head as
`e56bb9e2c531e9cd3d97837465eca92d5e2c31dd`; jobs that built reports and
artifacts executed against the pull-request merge revision
`991b28142783833c14be659125c4564d14219cc5`. These identities are related but
not interchangeable.

The direct platform evidence in that run includes:

- native accessibility jobs `95054897228` (macOS) and `95054897192` (Windows);
- package jobs `95054897243` (macOS) and `95054897272` (Windows), including
  fixture-free picker save/open/cancel;
- fresh download, validation, and launch jobs `95059000291` (macOS) and
  `95059000304` (Windows);
- unsigned signing-input assembly job `95059000309`; and
- required aggregate job `95059146281`.

The picker executable SHA-256 values were
`f7cfab51cbaf4163bc82ae74854b07d5fcd8eb98219050fcb84e18e59c372172` on
macOS and `e82079f1ee6b6afff7418b94a6299bb72835178f778918b036e80df8659e343a`
on Windows. Platform package artifacts `9251605446` / `9251849187` have GitHub
digests
`sha256:483ab8a38b9debfa8b0dcbf3fb9562b1c1d37bc620b47b1c1e5d20d6b562bbaa`
and
`sha256:865954eae51ce7a8c2b93224bf8f2ac1d1ed05917649f31acac94c57482c2044`.
The `unsigned-signing-input` artifact `9251864491` has GitHub digest
`sha256:994c1ff87604f605130ebd5aa38718788157080c5a1176bb9231e51c8ef96abd`.

This evidence closes the direct G3B-05, G5-03P/G5-04P, G5-09, and MVP-01
platform gates. It does not promote N-10 or N-11: the run was a pull-request
run, `collect_mvp_proof` was `false`, and the native accessibility and
clean-package proof recording/upload steps were skipped. It also did not sign,
notarize, publish, or promote any artifact. The generated
`release/mvp-evidence.json` remains untouched pending the canonical clean-tag
promotion.

## Current boundary

The checked-in policy remains fail-closed while those external gates are
pending. A successfully generated record is not a passing MVP gate while any
case is failed or blocked. Do not edit a generated record's revision or mark a
blocked case as passed without retaining the corresponding hosted run and
artifact links.

The repository contains successful direct platform evidence, but not a
successful clean-tag schema-v5 promotion record. N-10, N-11, and MVP-02
therefore remain pending even though the corresponding UIA, picker, package,
and clean-launch jobs passed in the PR run.

The same run closed the revision-bound hosted supply-chain gate, and its
`performance-required` jobs passed the already-active macOS/Windows budgets.
The wider release boundary remains open for public-registry clean-user proof,
credential owners and protected Environment reviewers, real macOS/Windows
signing and notarization/timestamping, clean-tag rehearsal, registry channel
promotion, an independent approving review, and the final seven-asset GitHub
prerelease/publication record. These conditions keep G6-06P, G6-08P, and
G6-09P pending; direct PR jobs and candidate rehearsals cannot substitute for
them.
