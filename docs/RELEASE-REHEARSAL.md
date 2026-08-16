# Release Rehearsal

G6-08 is a staging proof for the Technical Preview release path. The complete
sequence is **tag -> artifact -> fresh download -> integrity verification ->
launch boundary -> rollback exercise -> owner decision**. It does not publish,
sign, notarize, promote, overwrite, or delete a package version.

The executable policy is [`release/rehearsal-policy.json`](../release/rehearsal-policy.json),
the runner is [`tools/release-rehearsal.mjs`](../tools/release-rehearsal.mjs),
and the isolated hosted path is
[`release-rehearsal.yml`](../.github/workflows/release-rehearsal.yml).

## Safety boundary

- `candidate` mode accepts a branch and dirty descriptor, but its outcome is
  always `candidate-only`.
- `tag` and `publishable` modes require a clean checkout at exactly
  `refs/tags/v<release/version.json npmTrain>` and verify that the tag resolves
  to the requested revision.
- The producer creates unsigned npm tarballs and an unsigned packaged
  application. The application is placed in a tar archive so executable modes
  survive artifact transport.
- A new checksum/SBOM/provenance set covers both the npm tarballs and the
  application archive. `rehearsal-manifest.json` separately inventories the
  descriptor, launch contract, evidence, and every transported artifact.
- Launch always reruns transport and release-evidence verification before
  extraction. Archive paths, symlinks, special files, executable location,
  output volume, observation time, and termination time are bounded.
- Rollback modifies only a newly copied quarantine directory. The source
  candidate and last-known-good pointer are never changed.

`node-probe` launch descriptors exist only for the local candidate contract
test. Tag and publishable candidates accept native application descriptors
only.

For a labeled pull request, `ci.yml` runs one revision-bound
`performance.yml` invocation with `require_active: true` and passes its GitHub
job result into the candidate rehearsal. The rehearsal resolver accepts only
`success` and requires its internal performance job to be `skipped`, so the
same revision is not judged by two independent hosted samples. Manual and tag
rehearsals receive no caller result and therefore run the active performance
workflow internally. Neither path changes the budget, statistic, sample count,
or pending-baseline behavior.

## Local candidate rehearsal

Use a new directory for every producer, download, extraction, and rollback
path. The native consumer build can take several minutes.

```bash
pnpm install --frozen-lockfile
pnpm release:preflight
node tools/release-rehearsal.mjs validate-policy
node --test tools/release-rehearsal.test.mjs

git rev-parse HEAD
git symbolic-ref HEAD
node tools/release-consumer.mjs --output /tmp/nexa-release-producer

node tools/release-rehearsal.mjs prepare \
  --mode candidate \
  --ref refs/heads/<current-branch> \
  --revision <full-head-sha> \
  --platform darwin-arm64 \
  --release-output /tmp/nexa-release-producer \
  --bundle /tmp/nexa-release-bundle

cp -R /tmp/nexa-release-bundle /tmp/nexa-release-fresh-download
node tools/release-rehearsal.mjs verify \
  --mode candidate \
  --ref refs/heads/<current-branch> \
  --revision <full-head-sha> \
  --platform darwin-arm64 \
  --bundle /tmp/nexa-release-fresh-download

node tools/release-rehearsal.mjs launch \
  --mode candidate \
  --ref refs/heads/<current-branch> \
  --revision <full-head-sha> \
  --platform darwin-arm64 \
  --bundle /tmp/nexa-release-fresh-download \
  --extract /tmp/nexa-release-launch

node tools/release-rehearsal.mjs rollback \
  --mode candidate \
  --ref refs/heads/<current-branch> \
  --revision <full-head-sha> \
  --platform darwin-arm64 \
  --bundle /tmp/nexa-release-fresh-download \
  --output /tmp/nexa-release-rollback \
  --last-known-good none-first-preview
```

`pnpm release:preflight` is a read-only aggregate status check. It validates the
canonical readiness, signing, and performance policies and reports source/tag
state, the selected bootstrap/final gate set, signing owner and credential
blockers, and every pending metric for both hosted platforms. Exit `0` means the
selected release phase is ready, exit `1` means valid policy is still blocked,
and exit `2` means usage or policy validation failed. For machine-readable JSON
without pnpm lifecycle output, run:

```bash
node tools/release-preflight.mjs --phase final --json
```

The checked-in Technical Preview policy is expected to return `1` until the
external evidence described below is promoted. Preflight never enables release
execution, activates credentials, changes a baseline, writes evidence, creates
a tag, or contacts a registry.

Use `darwin-x64` or `win32-x64` only on the matching host. The sentinel
`none-first-preview` means there is no previously promoted Technical Preview;
after the first promotion, set `NEXA_LAST_KNOWN_GOOD` to the immutable prior
version.

## Hosted tag rehearsal

1. Confirm `release/version.json`, Changesets, changelog, compatibility matrix,
   and release notes all name the same version.
2. Confirm the source is clean and every required pull-request check is green.
3. Create `v<version>` at the reviewed commit. A tag push enters `tag` mode;
   manual runs default to non-promotable `candidate` mode.
4. Record the workflow run URL, commit, tag, Node/pnpm/Rust/Perry versions,
   per-platform candidate artifact IDs, download artifact digests, verification
   records, launch records, rollback records, and final decision.
5. Require `source`, `contracts`, `security`, `performance`, `consumer`,
   `freshVerification`, `launch`, and `rollback` to report `success`.
6. Treat a passed result as `owner-review-required`. It is not publication or
   signing authorization.

The current performance policy contains reviewed active native baselines for
both hosted platforms. `require_active: true` still fails closed if any metric
returns to pending or if a candidate exceeds its active budget. Workflow
configuration or a local candidate run is not hosted success evidence.

## First registry bootstrap and final promotion

The first `0.1.0` npm train has a deliberate two-stage path. This is a narrow
exception for the initial empty registry, not a way to skip final evidence:

1. Run `release-evidence.yml` with `publication_phase=bootstrap`, the exact MVP,
   rehearsal, and signing run IDs, and an empty registry run ID. The resulting
   bundle contains seven revision-bound gates and remains unusable as final
   evidence.
2. Run `release.yml` with `operation=bootstrap-publication`, that bootstrap
   evidence run ID, and the same signing run ID. The protected job may publish
   only the immutable nine-package train under
   `technical-preview-staging-<first-12-revision-hex>`; it cannot promote the
   `technical-preview` channel.
3. Run `registry-evidence.yml` with `phase=bootstrap`. A fresh hosted consumer
   verifies authoritative metadata, SHA-512 integrity, lockfile resolution,
   typecheck, native ESM imports, and `nexa doctor` against the staging tag.
4. Run `release-evidence.yml` with `publication_phase=final` and the registry
   proof run ID in addition to the original three run IDs. This bundle requires
   all eight gates.
5. Run `release.yml` with `operation=request-publication` and the final evidence
   bundle. Before npm mutation, the final-only path prepares and attests the
   exact seven GitHub Release assets, then creates or reconciles a draft
   prerelease at the exact tag/full commit. It fresh-downloads existing assets,
   verifies their digests, uploads only missing matching files, forbids
   `--clobber`, and verifies the remote allowlist again. Bootstrap never creates
   a GitHub Release.
6. Final npm publication refuses to create a missing version and only promotes
   the already verified train to `technical-preview`. The publisher then queries
   all nine packages again; any remaining or unexpected promotion fails closed.
   Only after this convergence may the workflow fresh-verify and publish the
   GitHub draft, then persist a publication record binding the Release ID/URL,
   release/signing runs, seven public asset digests, and npm package integrity.
   The record is a workflow artifact, not an eighth public Release asset. A
   subsequent `registry-evidence.yml` run with `phase=final` can independently
   attest the promoted channel.

Every step is manual, tag/revision-bound, and protected. The checked-in policy
remains disabled; local tests cannot activate either publication phase. npm
versions become public and immutable during bootstrap even though the public
channel is not promoted. `resume_registry_train` is therefore bootstrap-only
and is allowed solely after owner inspection confirms a dependency-ordered,
digest-matching prefix from an interrupted run. A gap, digest mismatch, wrong
phase, or content/gate failure requires stopping promotion and issuing a new
version; no workflow overwrites or unpublishes the failed version. Concurrent
release runs for the same ref are serialized, and a partially reconciled draft
remains non-public when npm convergence fails.

## Rollback checklist

Any failed, cancelled, or skipped required gate produces
`rollback-required` and blocks promotion.

1. Stop promotion and keep the downloaded candidate plus evidence quarantined.
2. Leave the last-known-good version current. For the first preview, leave the
   channel empty and retain `none-first-preview` in the record.
3. Do not publish, sign, notarize, overwrite, unpublish, or invoke a remote
   workflow to repair the same immutable version.
4. Open a corrective change, update the version, and run a new candidate from
   the beginning.
5. Retain the failed-gate decision, quarantine trigger, artifact digests, and
   logs with the release evidence.

The rollback job deliberately changes an isolated npm tarball copy and must
observe an integrity failure. Success means the rollback mechanism detected
the change, retained evidence, and left the source candidate untouched.
