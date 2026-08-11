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
N-10 remains blocked until a Windows hosted UI Automation client completes
through the production AccessKit/Dispatcher path. N-11 remains blocked until
fresh macOS and Windows artifact downloads pass checksum and five-second clean
launch checks. Those two cases deliberately have no local command or execution
record.

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

## Current boundary

The checked-in policy remains fail-closed while those external gates are
pending. A successfully generated record is not a passing MVP gate while any
case is failed or blocked. Do not edit a generated record's revision or mark a
blocked case as passed without retaining the corresponding hosted run and
artifact links.

The repository currently contains the producer configuration and deterministic
contracts, not a successful hosted promotion record. Windows UI Automation,
real macOS/Windows picker execution, and dual-platform clean artifact launch
still require revision-bound hosted runs.

The wider release gates are also still open: revision-bound hosted npm/Cargo
advisory, license, and gitleaks scans; public-registry clean-user proof; active
macOS/Windows performance baselines; real credential activation and
dual-platform signed staging; clean-tag rehearsal; registry channel promotion;
and the final seven-asset GitHub prerelease/publication record have not run
successfully. Local contracts and the encoded signing or publication paths do
not close G6-04P, G6-06P, G6-07P, G6-08P, or G6-09P.
