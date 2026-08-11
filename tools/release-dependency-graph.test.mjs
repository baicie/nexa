import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDependencyGraph, validateDependencyGraph } from "./release-dependency-graph.mjs";

const sources = [
  {
    ecosystem: "npm",
    lockfile: "pnpm-lock.yaml",
    resolver: "pnpm list --prod --json --depth Infinity",
    digest: { sha256: "a".repeat(64) },
  },
  {
    ecosystem: "cargo",
    lockfile: "Cargo.lock",
    resolver: "cargo metadata --locked --format-version 1",
    digest: { sha256: "b".repeat(64) },
  },
];

const npmProjects = [
  {
    name: "@nexa/ui",
    version: "0.1.0",
    dependencies: {
      "@nexa/protocol": {
        name: "@nexa/protocol",
        version: "0.1.0",
        dependencies: {},
      },
    },
  },
];

const cargoMetadata = [
  {
    packages: [
      {
        id: "path+file:///repo/packages/nui-host#host@0.1.0",
        name: "host",
        version: "0.1.0",
        source: null,
        manifest_path: "/repo/packages/nui-host/Cargo.toml",
        license: "MIT OR Apache-2.0",
      },
      {
        id: "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0",
        name: "serde",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        manifest_path: "/cargo/registry/serde/Cargo.toml",
        license: "MIT OR Apache-2.0",
      },
    ],
    resolve: {
      workspace_members: ["path+file:///repo/packages/nui-host#host@0.1.0"],
      nodes: [
        {
          id: "path+file:///repo/packages/nui-host#host@0.1.0",
          deps: [
            {
              pkg: "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0",
              dep_kinds: [{ kind: null }],
            },
          ],
        },
        {
          id: "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0",
          deps: [],
        },
      ],
    },
  },
];

test("normalization emits deterministic npm and Cargo dependency closures", () => {
  const graph = normalizeDependencyGraph({
    sources,
    npmProjects,
    cargoMetadata,
    rootDirectory: "/repo",
  });

  assert.equal(graph.schemaVersion, 1);
  assert.deepEqual(graph.sources, sources);
  assert.equal(graph.roots.npm.length, 1);
  assert.equal(graph.roots.cargo.length, 1);
  assert.equal(graph.components.length, 4);
  assert.deepEqual(
    graph.components.map(({ ecosystem, name, version }) => [ecosystem, name, version]),
    [
      ["cargo", "host", "0.1.0"],
      ["cargo", "serde", "1.0.0"],
      ["npm", "@nexa/protocol", "0.1.0"],
      ["npm", "@nexa/ui", "0.1.0"],
    ],
  );

  const rootDependency = graph.dependencies.find(({ ref }) => ref === graph.roots.cargo[0]);
  assert.deepEqual(rootDependency.dependsOn, [graph.components[1].ref]);
  const npmRootDependency = graph.dependencies.find(({ ref }) => ref === graph.roots.npm[0]);
  assert.deepEqual(npmRootDependency.dependsOn, [graph.components[2].ref]);
  assert.doesNotThrow(() => validateDependencyGraph(graph));
  assert.equal(
    JSON.stringify(graph),
    JSON.stringify(
      normalizeDependencyGraph({ sources, npmProjects, cargoMetadata, rootDirectory: "/repo" }),
    ),
  );
});

test("dependency graph validation fails closed for duplicate or unknown references", () => {
  const graph = normalizeDependencyGraph({
    sources,
    npmProjects,
    cargoMetadata,
    rootDirectory: "/repo",
  });
  assert.throws(
    () =>
      validateDependencyGraph({ ...graph, components: [...graph.components, graph.components[0]] }),
    /duplicate dependency component reference/u,
  );
  assert.throws(
    () =>
      validateDependencyGraph({
        ...graph,
        dependencies: [...graph.dependencies, { ref: "urn:unknown", dependsOn: [] }],
      }),
    /unknown dependency reference/u,
  );
});
