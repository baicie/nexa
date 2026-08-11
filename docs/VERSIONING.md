# Versioning And Release Policy

Nexa UI Technical Preview uses independent compatibility axes:

| Axis                      | Current value                | Change rule                                                                                                  |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| npm fixed release train   | `0.1.0`                      | Nine public npm packages, including the sole Tier-1 `@nexa/adapter-solid`, move together through Changesets. |
| Rust implementation train | `0.1.0`                      | Internal and vendored only; no standalone Rust crate is public in this Preview.                              |
| Protocol                  | `1.0.0`                      | Changes only through a protocol ADR and generated-artifact gate.                                             |
| Host ABI                  | `0.5`                        | Changes only with a native bridge compatibility review.                                                      |
| Perry                     | `0.5.1220`                   | Pinned; upgrades require a clean four-framework AOT rehearsal.                                               |
| Node / pnpm / TypeScript  | `>=22` / `10.34.3` / `5.9.2` | Toolchain changes require CLI and consumer fixture rehearsal.                                                |

## SemVer rules

The public npm train remains `0.x` during Technical Preview. A breaking public
API or native behavior change increments the minor version; compatible features
and fixes use the patch version. Protocol and Host ABI compatibility are not
inferred from npm SemVer: their independent axes and ADRs are authoritative.
Deprecations require one documented release note and at least one release train
before removal. Private adapters may change independently and do not establish
support-tier guarantees.

## Release process

1. Add a Changeset describing user-visible changes and the affected public set.
2. Run `pnpm changeset status`, `pnpm version:check`, and
   `pnpm version:rehearse`. The rehearsal itself creates and removes an isolated
   temporary workspace, executes `changeset version`, checks the fixed train,
   generated changelogs and workspace ranges, then packs and inspects all nine
   generated manifests without changing the source tree.
3. Build, pack, install the actual tarballs in the consumer fixture, and run the
   platform package matrix.
4. Review the generated CHANGELOG and compatibility matrix.
5. Obtain explicit release-owner approval before registry publication,
   application signing, notarization, or hosted release execution.

The canonical values are stored in [`release/version.json`](../release/version.json)
and are checked against package manifests, Cargo workspace metadata, and the
CLI doctor constants. The checker never changes Protocol or Host ABI values.
