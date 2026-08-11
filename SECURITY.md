# Security Policy

## Supported versions

The Desktop Technical Preview has not been released. During preview development,
only the latest `0.1.x` revision on the default branch receives security fixes.
Older commits, local snapshots, and Preview-after-backlog branches are
unsupported.

## Reporting a vulnerability

Use a private GitHub Security Advisory at:

https://github.com/baicie/nexa-ui/security/advisories/new

Do not open a public issue, pull request, discussion, or chat message for a
suspected vulnerability. Include affected versions, platform and architecture,
impact, reproduction steps, and any known mitigation. Do not include real user
data, credentials, or destructive proof-of-concept payloads.

The maintainer will acknowledge a complete report within 3 business days,
provide an initial severity assessment within 7 business days, and coordinate a
fix and disclosure timeline based on exploitability and release status. These
are response targets, not a bounty or warranty commitment.

## Scope

Security-sensitive areas include protocol/FFI decoding, generation handles,
permission manifests, filesystem and dialog task boundaries, package staging,
artifact provenance, and release credentials. Denial of service that requires a
hostile process with the same local file permissions remains subject to the
documented Technical Preview limitations.
