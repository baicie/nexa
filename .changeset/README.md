# Release Changesets

Every public package behavior change gets a markdown changeset before merge.
The nine public packages are one fixed `0.x` release train; private adapters,
the Svelte subset, and the system umbrella are ignored by Changesets.

The initial `0.1.0` Technical Preview candidate is already represented by the
unreleased root changelog and package versions. Its empty changeset acknowledges
the initial candidate without incorrectly advancing the fixed train to `0.1.1`.

```bash
pnpm changeset
pnpm changeset status
pnpm version:check
pnpm version:rehearse
```

The version rehearsal runs in a temporary copy, checks the generated versions,
internal dependency ranges, changelog entries, packed manifests, and consumer
fixture, then removes the copy. It does not modify the working tree. Registry
publish and application signing remain explicit release-owner actions.
