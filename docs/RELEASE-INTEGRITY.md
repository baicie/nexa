# Release Integrity Evidence

`tools/release-evidence.mjs` is the offline, deterministic integrity proof for
the Technical Preview. It operates on a directory containing the already-built
release files plus a dependency-graph-bearing descriptor and writes three
sidecar documents:

| File                      | Format                                    | Purpose                                                    |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `SHA256SUMS`              | GNU-style SHA-256 list                    | Detects a changed, missing, or unexpected artifact         |
| `sbom.cdx.json`           | CycloneDX 1.6 JSON                        | Exact files plus npm and Cargo production dependency graph |
| `provenance.intoto.jsonl` | in-toto Statement v1 / SLSA provenance v1 | Binds artifact digests to source, builder, and build time  |

The output names and schema versions are fixed by
`release/artifact-integrity.json`. File discovery is recursive, sorted by
portable POSIX path, and rejects symlinks, special files, empty bundles, and
artifact/evidence directory overlap. SHA-256 is computed in 1 MiB chunks, so
large archives do not need to fit in memory.

## Build descriptor

The caller supplies a JSON descriptor. `sourceDateEpoch` is required: it makes
timestamps and the derived invocation ID reproducible across reruns.

```json
{
  "schemaVersion": 1,
  "release": { "name": "nexa-ui", "version": "0.1.0" },
  "source": {
    "repository": "https://github.com/baicie/nexa-ui",
    "revision": "0123456789abcdef0123456789abcdef01234567",
    "dirty": false
  },
  "build": {
    "builderId": "https://github.com/baicie/nexa-ui/.github/workflows/release.yml",
    "buildType": "https://nexa-ui.dev/build-types/technical-preview/v1",
    "sourceDateEpoch": 1786233600
  },
  "materials": [
    {
      "uri": "https://github.com/baicie/nexa-ui/blob/0123456789abcdef0123456789abcdef01234567/pnpm-lock.yaml",
      "digest": { "sha256": "<pnpm-lock-sha256>" }
    },
    {
      "uri": "https://github.com/baicie/nexa-ui/blob/0123456789abcdef0123456789abcdef01234567/packages/nui-host/Cargo.lock",
      "digest": { "sha256": "<cargo-lock-sha256>" }
    }
  ],
  "dependencyGraph": {
    "schemaVersion": 1,
    "sources": [
      {
        "ecosystem": "npm",
        "lockfile": "pnpm-lock.yaml",
        "resolver": "pnpm list --filter <public-package> --prod --json --depth Infinity",
        "digest": { "sha256": "<pnpm-lock-sha256>" }
      },
      {
        "ecosystem": "cargo",
        "lockfile": "packages/nui-host/Cargo.lock",
        "manifest": "packages/nui-host/Cargo.toml",
        "resolver": "cargo metadata --manifest-path packages/nui-host/Cargo.toml --locked --format-version 1",
        "digest": { "sha256": "<cargo-lock-sha256>" }
      }
    ],
    "roots": {
      "npm": ["urn:nexa:dependency:npm:sha256:<digest>"],
      "cargo": ["urn:nexa:dependency:cargo:sha256:<digest>"]
    },
    "components": ["<normalized library components>"],
    "dependencies": ["<normalized dependency edge sets>"]
  }
}
```

The component and edge arrays above are abbreviated for readability; the
producer writes complete typed objects for every reachable dependency.

`materials` contains the root pnpm/Cargo lockfiles. Every dependency-graph
source must match one of those materials by path and SHA-256; a graph cannot be
substituted without changing the descriptor and provenance. The source
repository and commit are always emitted as a resolved Git dependency.
`source.dirty` is mandatory: local rehearsals may set it to `true`, while a
publishable hosted release must fail unless it is `false`.

## Dependency graph

`tools/release-dependency-graph.mjs` collects two structured, locked graphs:

- `pnpm list --filter <public-package> --prod --json --depth Infinity` starts
  from every package in `release/packages.json` and excludes root development
  tooling;
- `cargo metadata --locked --format-version 1` starts independently from the
  NUI Host and System Host manifests, follows normal and build dependencies,
  and excludes dev-only dependencies.

The collector normalizes absolute paths, sorts all components and edges,
deduplicates shared Rust crates, and records the exact pnpm and Host Cargo lock
digests. The descriptor carries this normalized graph. Evidence generation
rejects duplicate references, unknown edges, missing edge sets, unreachable
components, unsupported ecosystems, and lockfile/material digest drift.

CycloneDX `type: file` components describe the transported archives.
`type: library` components describe the npm/Cargo closure, with package URLs
where the source has a stable registry identity. The release component points
to all npm and Cargo roots through the CycloneDX `dependencies` graph.

## Generate and verify

```bash
node tools/release-evidence.mjs generate \
  --artifacts .nexa-release/artifacts \
  --evidence .nexa-release/evidence \
  --descriptor .nexa-release/descriptor.json

node tools/release-evidence.mjs verify \
  --artifacts .nexa-release/artifacts \
  --evidence .nexa-release/evidence \
  --descriptor .nexa-release/descriptor.json
```

Verification recomputes the artifact set and regenerates all three documents;
it compares the bytes with the sidecars, not just selected JSON fields. This
keeps ordering, timestamps, and formatting deterministic and fails closed for
artifact additions/removals, content changes, descriptor drift, malformed
JSON, or non-canonical whitespace.

Verification uses only the downloaded artifacts, descriptor, and sidecars; it
does not resolve packages or contact a registry. The generated provenance is
unsigned metadata; a hosted release job must attest/sign it after independent
artifact validation. This local tool never publishes or signs. Graph
generation may access registries through the locked package managers when a
producer cache is cold, but that state is not needed by the fresh verifier.

The dependency graph does not enumerate operating-system frameworks, DLLs,
drivers, fonts, or other runtime resources supplied by macOS/Windows. Security
advisories and license allowlists remain separate G6-04 gates; presence in the
SBOM is not a claim that a component is vulnerability-free.

## Final GitHub Release integrity

`tools/github-release.mjs` converts the already verified two-platform signed
transport into an exact seven-file public allowlist:

- `nexa-notes-0.1.0-macos-arm64-signed.tar.gz`;
- `nexa-notes-0.1.0-windows-x64-signed.zip`;
- `SHA256SUMS`;
- `sbom.cdx.json`;
- `provenance.intoto.jsonl`;
- `release-manifest.json`;
- `signing-custody.json`.

The names are version-derived and extra files fail closed. The release
manifest binds the clean full revision and exact tag, draft/prerelease state,
signing run, version-bound release-notes digest, and the payload files. The
checksums cover every other public asset, while the SBOM and provenance bind
the two signed application archives. `release.yml` also requests GitHub build
provenance attestation for the prepared set.

Final reconciliation verifies the GitHub Release tag, full target SHA, title,
notes, draft/prerelease state, and exact asset set. Existing assets are freshly
downloaded and hashed before any mutation; only missing assets may be uploaded
and `--clobber` is forbidden. The complete remote set is freshly downloaded
and verified again both after reconciliation and before the draft is made
public. Publication waits for a second authoritative observation that all
nine npm packages have converged on the `technical-preview` channel. The
resulting publication-record workflow artifact binds the Release ID/URL,
release/signing runs, seven asset digests, and npm integrities, but is not part
of the public seven-file allowlist.

These are fail-closed contracts only until the protected final workflow runs.
The bootstrap npm phase never creates a GitHub Release, and the repository
currently contains no final Release or publication record for this revision.

## Verification boundary

`SHA256SUMS` proves bytes relative to the evidence bundle. The SBOM and
provenance bind the same subject names and hashes to the descriptor. A trusted
release still needs the external controls listed in `docs/SUPPLY-CHAIN.md`:
immutable CI action references, dependency/license/secret scans, hosted
platform builds, and a signature or transparency-log attestation over the
evidence. Those CI and signing controls remain separate from this local
evidence tool.
