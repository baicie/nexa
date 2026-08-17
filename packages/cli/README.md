# `@nexa/cli`

Developer CLI for the Nexa UI Desktop Technical Preview.

```bash
nexa new my-app
cd my-app
nexa doctor
nexa dev
nexa build
nexa package
```

`new` creates a standalone Minimal TSX project skeleton with a deny-all
application manifest. It never installs packages and refuses absolute paths,
parent traversal, symbolic links, and non-empty targets. The generated
`@nexa/*` dependencies require a registry where the Technical Preview SDK has
been published or made available. The candidate manifests and local tarballs
are publishable, but this source snapshot has not performed a registry publish.

`doctor` checks Node, pnpm, Perry and both Nexa Hosts from the current project's
declared dependency graph, plus Host ABI versions and the current Technical
Preview target. It executes the resolved Perry package bin directly, so an
ancestor, `NODE_PATH`, or PATH-only install cannot pass. Use `--json` for a
stable machine-readable report. A failed required check returns exit code 1;
invalid command usage returns exit code 2.

`dev` and `build` use the conventional project files `package.json`,
`src/main.tsx`, and `app.manifest.json`. They resolve the exact compatible Perry
package from the current project's installed dependency graph and execute its bin
with the current Node process, without a shell, `pnpm exec`, or PATH lookup.
Supported Technical Preview targets are macOS arm64/x64 and Windows x64.

`dev` delegates watch, recompile, and run behavior to Perry and writes its owned
temporary binary below `.nexa/dev/`. `build` writes
`dist/<package-basename>[.exe]`; Windows builds select the GUI subsystem. Both
commands validate the schema-v1 manifest before starting Perry, replace the
build-time manifest path with its verified absolute path, and remove Nexa/Perry
test bypass variables. A successful build is accepted only when the output is a
regular file containing the exact manifest bytes and no Dialog fixture canary.

`package` always runs that trusted `build` first; there is no skip-build path.
It emits an unsigned current-target distribution below
`dist/<package-basename>-<macos|windows>-<arch>/`:

- macOS contains `<package-basename>.app`, with the executable under
  `Contents/MacOS/` and `Info.plist`, `app.manifest.json`, `nexa-build.json`,
  and optional assets in the standard bundle locations.
- Windows contains `<package-basename>.exe`, `app.manifest.json`,
  `nexa-build.json`, and optional `assets/` at the distribution root.

The metadata records the app identity, protocol, target, compatible toolchain
versions, and asset totals. Optional project-root `assets/` preserve their
relative layout and are limited to 4,096 regular files, 64 MiB per file, and
256 MiB in total. Symbolic links and other non-regular asset entries are
rejected. The packaged distribution does not include `node_modules`, Cargo
`target`, project source, `.nexa`, or global tool directories and does not need
those development files when launched.

Packaging stages content under the project root, exclusively reserves the exact
destination, and refuses to overwrite an existing path. The macOS bundle is
moved into that reservation as a complete `.app`; Windows publishes individual
entries with `nexa-build.json` last as the completion marker and rolls back
catchable failures. The project root and `dist/` must still be controlled by the
caller: Node's portable filesystem API cannot prevent a hostile process with the
same permissions from renaming or relinking a parent after the final check. A
forced process termination can leave an incomplete reserved Windows directory,
which a retry will refuse to overwrite.

The general implementation is `src/package.mjs`. The repository's Notes
reference app intentionally keeps its specialized
`tools/reference-notes-package.mjs`; it does not define the generic CLI's app
name, permissions, or packaging helpers. Neither path performs signing,
notarization, installer/archive creation, or publishing. Cross-platform hosted
artifact and launch evidence remains G5-09/MVP-01 work.

The repository-only create-to-package smoke accepts
`--artifact-output <path>` so CI can move an already verified distribution to
an unclaimed destination beside its temporary project. This is not a
`nexa package` option. The hosted workflow transports the generic and Notes
distributions separately, then a fresh job downloads, revalidates, and launches
both without checking out the repository or invoking a development toolchain.

Project, manifest, dependency, child-process, and artifact failures return exit
code 1. Unknown arguments or invalid command usage return exit code 2. The CLI
supports only macOS arm64/x64 and Windows x64 Technical Preview targets and does
not cross-package for a different target.
