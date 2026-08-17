# Supply Chain Policy

Technical Preview release inputs are locked, scanned, and fail closed. The
policy applies to the root pnpm graph and all four Cargo lockfiles: the
workspace, UI Host, System Host, and Windows unified-static-closure graphs.

## Required gates

- `pnpm audit --audit-level=high` against `https://registry.npmjs.org/`;
- `cargo audit` for every Cargo lockfile and locked `cargo deny` for every manifest root;
- npm and Cargo license allowlists;
- gitleaks history and working-tree scans;
- immutable full-length SHA references for every external GitHub Action;
- Dependabot updates for npm, all four independently locked Cargo roots, and Actions.

High or critical advisories block release. Registry errors, malformed reports,
missing scanners, and unrecognized licenses are failures, not warnings. MIT,
Apache-2.0, ISC, BSD, CC0 and other explicitly listed permissive licenses are
allowed. Copyleft or unknown licenses require a reviewed exception before merge.

## Audited platform features

`RUSTSEC-2026-0192` marks `ttf-parser` as unmaintained. The default `winit`
feature set previously reached it through `wayland-csd-adwaita`,
`sctk-adwaita`, `ab_glyph`, and `owned_ttf_parser`. The workspace therefore
disables `winit` defaults and explicitly enables `rwh_06`, `wayland`,
`wayland-dlopen`, `x11`, and `wayland-csd-adwaita-notitle`. This retains the
supported Linux window backends and client-side decorations without the title
font dependency chain; macOS and Windows behavior is unchanged.

Re-enabling the default feature set or `wayland-csd-adwaita` requires a new
four-lockfile audit and policy review. The advisory must not be ignored or
downgraded merely to make the release gate pass.

## Exceptions

Every exception records the exact package and version, reason, owner, and
expiration date. Expired, range-wide, or ownerless exceptions fail the gate.
`release/license-exceptions.json` is the canonical npm exception list. Changes
to allowlists or exceptions require `@baicie` review and a new hosted scan.

## Credentials and provenance

Release credentials are environment-scoped GitHub secrets and are never exposed
to pull requests or build scripts. Workflows default to read-only permissions.
Registry publish, application signing, and provenance attestation use separate
jobs after artifact validation. The synthetic token under
`tools/fixtures/security` is an allowlisted negative fixture and is not a real
credential.

The hosted secret gate downloads gitleaks `8.24.2` from its immutable release
URL, verifies the Linux x64 archive SHA-256, and first copies the synthetic
fixture outside its path allowlist. The rehearsal must exit with the dedicated
leak status before the same binary scans complete Git history and the working
tree. A missing scanner, checksum mismatch, operational error, or fixture that
is no longer detected fails the job.

GitHub repository settings must also require full-length Action SHAs. The local
policy prevents unpinned changes from merging but cannot retroactively secure an
Action that executed before the policy job.

## SBOM boundary

The CycloneDX evidence enumerates the public npm production closure and both
Host static-library Cargo closures from structured locked resolver output. Each
graph source digest must match a provenance material. Fresh verification is
offline and byte-for-byte deterministic; see `docs/RELEASE-INTEGRITY.md`.

SBOM enumeration complements rather than replaces `pnpm audit`, `cargo audit`,
`cargo deny`, and license policy. Platform-provided frameworks, DLLs, drivers,
fonts, and similar operating-system resources are outside the package-manager
graph and are tracked through the compatibility and signing runbooks.
