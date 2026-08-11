# Application Signing and Notarization

This runbook defines the G6-06 signing boundary for Nexa UI Technical Preview
application artifacts. A reviewed executor and environment credential helper
are installed and SHA-256-bound in policy, and the guarded workflow encodes the
complete unsigned-download, signing, custody-export, merge, and verification
path. It is not an enabled signing service: execution and credential activation
are disabled in policy, both protected platform jobs have literal
`if: ${{ false }}` gates, and no current run activates credentials or signs
bytes.

The source of truth is `release/signing-policy.json`. Validate it locally with:

```bash
node tools/signing-policy.mjs validate
node tools/signing-policy.mjs readiness --phase staging
node tools/signing-executor.mjs validate
node --test tools/signing-credentials.test.mjs tools/signing-policy.test.mjs tools/signing-executor.test.mjs tools/signing-workflow.test.mjs
```

The policy and executor validation commands succeed. Staging readiness must
fail until owners are assigned, protected Environments are configured, and
credential activation is reviewed. A successful local contract run is not
staging signed-release evidence and does not close G6-06.

Readiness evidence records are consumed from a separately downloaded evidence
root, not from the tag checkout. Each passed record is bound to the exact
revision/ref and carries a concrete run URL/job plus artifact name and
SHA-256. The release workflow must verify that external root before the
protected publication job; a checked-in label cannot stand in for that proof.

## Reviewed executor binding

`release/signing-policy.json` binds the reviewed executor v1.2.0 entrypoint,
semantic version, SHA-256 digest, closure digest, hosted runner image, and each
platform command path. Policy
validation recomputes the executor digest; changing
`tools/signing-executor.mjs`, a runner image, or a command path therefore
requires an explicit reviewed policy update. The executable paths are the
reviewed contracts for GitHub-hosted `macos-15` and `windows-2022` images, not
claims about arbitrary developer machines.

The executor is platform-neutral orchestration. It verifies the complete G6-05
input before creating a working copy or lazily calling
`createEnvironmentCredentialSession`. That helper strictly decodes the
environment-provided P12/PFX/P8 material, creates a private macOS keychain or
current-user Windows `NexaTechnicalPreview` store, validates the selected
identity/certificate, removes its source environment references after every
activation attempt, and returns an idempotent cleanup callback. The executor
then invokes the platform sequence and commits by exclusive creation into
signed custody. Logs must not emit secret values. Fake-tool contracts cover the
credential lifecycle plus `codesign`, `notarytool`, `stapler`, and `spctl` on
macOS and `signtool` and `Get-AuthenticodeSignature` on Windows. These contracts
prove fail-closed orchestration, not real credential activation or signing.

## Ownership and credential boundary

| Platform | Protected GitHub Environment            | Credential owner placeholder        | Required material                                                                                    |
| -------- | --------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| macOS    | `technical-preview-signing-macos`       | `UNASSIGNED_MACOS_SIGNING_OWNER`    | Developer ID Application P12/password and App Store Connect API private key; identity/team/key IDs   |
| Windows  | `technical-preview-signing-windows`     | `UNASSIGNED_WINDOWS_SIGNING_OWNER`  | Authenticode PFX/password; certificate thumbprint and approved RFC3161 timestamp endpoint            |
| Incident | No credential access; release authority | `UNASSIGNED_RELEASE_INCIDENT_OWNER` | Authority to quarantine/withdraw a release and initiate certificate revocation only after compromise |

Before staging signing is enabled, each placeholder must be replaced by a
named GitHub team or accountable maintainer. Both platform Environments require
reviewers independent of the workflow author. Build, pull-request, and unsigned
package jobs must not receive Environment access. The owner records certificate
subject, thumbprint, issuer, validity window, renewal date, and revocation
contact outside the repository; only secret and variable names live here.

Credential files are written only under a GitHub-hosted ephemeral runner's
temporary directory with owner-only permissions. The macOS certificate is
imported into a new temporary keychain. The Windows certificate is imported
into a dedicated temporary store under the current runner user, never the
machine store. An executor cleanup step guarded by `if: always()` removes the
exact files, keychain/store, imported certificate, and derived environment
variables created by that run on success, cancellation, timeout, and failure.
Hosted runner destruction is the final containment boundary if a job is
forcibly terminated before cleanup can execute. Logs must never print secret
values, P12/PFX bytes, passwords, private keys, or unredacted tool arguments.

## Artifact classes and custody

Signing is a promotion between three disjoint, immutable roots:

```text
release-work/unsigned/    verified G5 output; suffix -unsigned; never publishable
release-work/signed/      derived copy; suffix -signed; the only publishable class
release-work/quarantine/  failed/ambiguous output; suffix -quarantine; never publishable
```

Archive names follow
`{app}-{version}-macos-{arch}-{class}.tar.gz` and
`{app}-{version}-windows-{arch}-{class}.zip`.
`reference-notes-package.yml` is the canonical unsigned signing-input producer:
its platform jobs create the fixed macOS and Windows unsigned archives, and its
`signing_input` job assembles and re-verifies the single
`unsigned-signing-input` artifact containing both archives, the G6-05
descriptor, and its evidence. A guarded `signing.yml` request accepts that
producer's run as `unsigned_run_id`, validates the external run workflow and
revision, downloads the named artifact from that run, and verifies it again
before credential activation. `release-rehearsal.yml` does not duplicate this
producer.

`executeSigning` requires an explicit
`unsignedEvidence: { descriptorPath, evidenceDir }` input and runs the canonical
`release-evidence.mjs` verifier over the complete unsigned custody root before
creating a working copy or activating credentials. It also requires a clean
descriptor whose revision matches the requested signing revision and whose
release version matches the selected archive. Missing, changed, or additional
unsigned artifacts therefore fail at the integrity boundary. Custody schema v3
and the signed SLSA provenance record the descriptor, every verified sidecar,
their individual SHA-256 digests, and a deterministic bundle digest. The
executor must never sign in place, overwrite across classes, rename unsigned
bytes as signed, or reuse evidence generated for the unsigned archive.

After signing, the executor recreates the platform archive in the signed root,
generates new `SHA256SUMS`, `sbom.cdx.json`, and
`provenance.intoto.jsonl` files for the signed bytes, then performs fresh
archive verification and launch before sealing custody. The guarded assemble
job exports and merges both platform custody roots, builds the signed transport
manifest, and independently runs publisher verification before upload. The
provenance records the unsigned input digest, signing workflow run ID, platform,
tool versions, certificate thumbprint, and notarization/timestamp result.
Private keys and passwords are not provenance material.

Technical Preview is a two-platform release. macOS success with Windows failure
or Windows success with macOS failure is partial failure; neither artifact is
promoted.

## GitHub Release custody

Signed transport is an input to final publication, not permission to publish.
Only the `request-publication` phase prepares the exact seven-file public asset
set: the two platform signed archives, `SHA256SUMS`, `sbom.cdx.json`,
`provenance.intoto.jsonl`, `release-manifest.json`, and
`signing-custody.json`. The manifest binds the exact tag/full target commit,
version-bound release-notes digest, signing workflow run, and every public
payload digest. GitHub's provenance attestation action covers that exact set.
The bootstrap npm phase does not create a GitHub Release.

The final workflow creates or verifies a draft prerelease, fresh-downloads any
existing remote assets, compares their sizes and SHA-256 values, and uploads
only missing matching assets. It never uses `--clobber`, repairs a published
partial release, or trusts remote asset metadata without downloading the
bytes. It fresh-downloads and verifies the exact seven-file allowlist again
before npm publication. The draft becomes public only after the final npm
publisher re-observes all nine packages converged on `technical-preview` with
no outstanding promotions. A separate workflow artifact records the GitHub
Release ID/URL, release and signing run IDs, all seven public asset digests,
and each npm package integrity; it is deliberately not an eighth public
Release asset.

## Common preconditions

The reviewed executor must stop before credential access unless all conditions
are true:

1. The source is an approved, clean, immutable release tag and the current
   commit passed required CI, security, package, and release-evidence gates.
2. The unsigned artifact was freshly downloaded, has the expected platform and
   architecture, and passes checksum/provenance verification.
3. The requested version and artifact names do not already exist in the signed
   or quarantine root. Release versions are immutable.
4. Both credential owners and the incident owner are assigned, both protected
   Environments have required reviewers, and the request is a staging signing
   request or a release request backed by a successful staging record. The
   reviewed executor policy must also set `credentialActivation` to `active`.
5. The exact nested-code and executable allowlists are derived from the package
   manifest. Unexpected executable files, symlinks, special files, or mutable
   input bytes fail closed before signing.

## macOS procedure

The executor operates on a copy of the `.app`. It inventories nested Mach-O
code and signs inside-out, then signs the outer application once with a
`Developer ID Application` identity, hardened runtime, and Apple's secure
timestamp. Entitlements must come from a reviewed, versioned allowlist; signing
must not use `codesign --deep` as a substitute for enumerating components.

The implementation records command output while redacting runner paths and
credential data. Before notarization, it verifies the code-directory hashes
for every architecture and records the sealed identity:

```bash
/usr/bin/codesign --verify --deep --strict --all-architectures --verbose=2 "Nexa Notes.app"
/usr/bin/codesign --display --verbose=4 "Nexa Notes.app"
```

Gatekeeper assessment is intentionally deferred until after notarization and
stapling. A correctly Developer ID-signed application can still be rejected by
Gatekeeper before its notarization ticket exists; that expected pre-notary
state must not be treated as a signing failure.

For notarization, create a temporary zip with `ditto` so bundle metadata is
preserved, then submit it with `xcrun notarytool submit ... --wait
--output-format json`. The executor saves the submission ID and full
`notarytool log` response. Only the exact `Accepted` result advances. `Invalid`,
rejection, timeout, malformed output, or inability to fetch the log is failure.

After acceptance, staple and validate the ticket on the application copy:

```bash
xcrun stapler staple "Nexa Notes.app"
xcrun stapler validate "Nexa Notes.app"
/usr/sbin/spctl --assess --type execute --verbose=4 "Nexa Notes.app"
```

All three commands must return zero. The Gatekeeper result must identify an
accepted notarized Developer ID application; a local policy override or an
ambiguous assessment is not release evidence.

Finally archive the stapled application as `-signed`, verify the signature and
ticket again after a fresh download and extraction, and launch it on a clean
macOS runner. Required evidence is `codesign-details.txt`, the notary submission
and log JSON, `stapler-validate.txt`, `spctl-assessment.txt`, and regenerated
integrity evidence.

## Windows procedure

The executor inventories the distribution and signs every allowlisted PE file,
including the application `.exe`, with Authenticode SHA-256. It imports the PFX
ephemerally into a run-specific current-user store, selects the expected
certificate by exact thumbprint, and refuses ambiguous, expired, not-yet-valid,
or private-key-less matches. The signing owner records the certificate subject,
issuer, enhanced key usage, validity window, renewal date, and revocation
contact before activation. Signing uses an approved RFC3161 server with SHA-256
for both file and timestamp digests. A missing timestamp is failure, even if
the base signature is otherwise valid.

The executor constructs the arguments without logging secret material. The
effective SignTool contract is equivalent to:

```powershell
signtool sign /s NexaTechnicalPreview /sha1 "$env:NEXA_WINDOWS_CERTIFICATE_THUMBPRINT" /fd SHA256 /tr "$env:NEXA_WINDOWS_RFC3161_TIMESTAMP_URL" /td SHA256 .\nexa-notes.exe
```

Every signed PE file is checked with Windows SDK SignTool and PowerShell:

```powershell
signtool verify /pa /all /v .\nexa-notes.exe
Get-AuthenticodeSignature -LiteralPath .\nexa-notes.exe | ConvertTo-Json -Depth 4
```

SignTool must return zero under default Authenticode policy for all signatures.
`Get-AuthenticodeSignature` must report `Status: Valid`, the signer thumbprint
must equal the approved value, and a timestamp certificate must be present.
Chain, revocation, timestamp, or policy warnings are failures rather than
allowed noise. SmartScreen reputation is not treated as cryptographic proof.

The executor then creates the `-signed` zip, regenerates integrity evidence,
downloads it in a fresh Windows job, repeats both verification paths, and
launches the executable. Required evidence is `signtool-verify.txt`,
`authenticode-status.json`, `certificate-chain.txt`, and regenerated integrity
evidence.

## Failure handling

Any prerequisite, import, signing, timestamp, notarization, stapling,
verification, evidence, upload, download, or launch failure stops the complete
release. The process must not fall back to an unsigned artifact and must not
publish the other platform after partial success.

The executor copies any derived output and redacted, non-secret diagnostics to
a unique quarantine path and then seals it immutable. It retains the original
immutable unsigned input and its digest for investigation, removes all
credential material in an unconditional `if: always()` cleanup step, and
reports the failing stage without retrying blindly. A retry starts on a fresh
hosted runner, downloads the original unsigned input again, and creates a new
working directory. It never resumes or overwrites an ambiguous signed or
quarantine directory.

Notarization service outages and timestamp service outages are release holds,
not bypass conditions. A rejected notarization or invalid Authenticode chain
requires owner review of the saved diagnostic evidence before another attempt.

## Rollback

Before publication, rollback means quarantining derived signed output and
leaving the unsigned source untouched. For a draft release, remove the draft
assets and mark the version failed; do not replace them in place. After public
publication, withdraw the affected version, keep or restore the last known-good
signed version as current where the distribution channel permits, publish an
incident notice, and build a new higher version from a clean tag. A published
version and its digests are never overwritten.

Certificate revocation is reserved for suspected or confirmed key compromise,
fraudulent signing, or an issuer-directed event. Ordinary build, timestamp, or
notarization failures do not justify revocation. On compromise, the incident
owner freezes both signing Environments, revokes the affected certificate with
the issuer, rotates all related secrets, audits signing logs, and requires a new
staging rehearsal before release resumes.

## Activation and staging evidence

`.github/workflows/signing.yml` supports only `workflow_call` and manual
`workflow_dispatch`. Its default `validate` operation is non-signing. It has
protected `macos-15` and `windows-2022` executor jobs, but each has a literal
`if: ${{ false }}` hard gate. This preserves the Environment boundary and the
unconditional `if: always()` cleanup shape without requesting an Environment or
credential. Both request operations invoke readiness first, which fails because
execution and credential activation are disabled, owners are unassigned, and
staging evidence is pending. The guarded jobs declare protected-Environment
secret/variable mappings and encode the full executor invocation, but the two
literal gates prevent those jobs from requesting an Environment, reading the
mapped values, or invoking the credential/signing path. `unsigned_run_id` is
therefore only an inactive, revision-bound transport input today.

Enabling signing requires a reviewed change that replaces owner placeholders,
creates protected Environments with independent reviewers, provisions their
secret and variable values, reviews the in-repository credential helper, changes
the literal platform gates, activates the policy, documents certificate metadata
and renewal ownership, and proves unconditional cleanup for every platform exit
path. It
must retain the SHA-256 executor binding, fake-tool contracts, exclusive
unsigned-to-signed/quarantine custody, and fail-closed request gate. Run a
staging release using non-production version metadata, then record the workflow
run URL/ID, commit, artifact digests, certificate thumbprints, notarization ID,
timestamp verification, fresh-download verification, and clean-runner launches
for both platforms. Only then may `stagingEvidence.status` become `passed` and
a release signing request become eligible.

No hosted credential activation, macOS signing/notarization, Windows
Authenticode/timestamping, signed staging rehearsal, or signed release success
is currently recorded. G6-06 remains open until that external evidence exists.
