import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PERRY_FRAMEWORK_MARKER,
  PERRY_FRAMEWORKS,
  runPerryFrameworkBuilds,
} from "./perry-frameworks.mjs";

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function outputSink() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
      },
    },
    value() {
      return value;
    },
  };
}

function successfulDependencies(overrides = {}) {
  return {
    spawn: () => result(0, "compiled\n"),
    exists: () => true,
    stat: () => ({ size: 42 }),
    remove: () => {},
    stdout: outputSink().stream,
    stderr: outputSink().stream,
    ...overrides,
  };
}

test("the Perry matrix includes the four Counter adapters and the Tier-1 Solid Notes slice", () => {
  assert.deepEqual(PERRY_FRAMEWORKS, [
    {
      id: "solid",
      packageName: "@nexa/example-solid-counter",
      directory: "solid-counter",
      output: "solid-counter",
      clean: ["dist"],
      script: "build",
    },
    {
      id: "solid-notes",
      packageName: "@nexa/example-reference-notes",
      directory: "reference-notes",
      output: "reference-notes-solid",
      clean: ["dist-solid"],
      script: "solid:build",
    },
    {
      id: "vue",
      packageName: "@nexa/example-vue-counter",
      directory: "vue-counter",
      output: "vue-counter",
      clean: [],
      script: "build",
    },
    {
      id: "react",
      packageName: "@nexa/example-react-counter",
      directory: "react-counter",
      output: "react-counter",
      clean: [],
      script: "build",
    },
    {
      id: "svelte",
      packageName: "@nexa/example-svelte-counter",
      directory: "svelte-counter",
      output: "svelte-counter",
      clean: ["dist"],
      script: "build",
    },
  ]);
});

test("the Svelte Counter build compiles and executes the real component fixture", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../examples/svelte-counter/package.json", import.meta.url), "utf8"),
  );
  const entry = readFileSync(
    new URL("../examples/svelte-counter/main.ts", import.meta.url),
    "utf8",
  );

  assert.match(packageJson.scripts.build, /^pnpm compile:svelte && perry compile main\.ts /);
  assert.match(packageJson.scripts.start, /^pnpm compile:svelte && perry compile main\.ts /);
  assert.match(entry, /import Counter from ["']\.\/dist\/Counter\.host\.js["']/);
  assert.match(entry, /new Counter\(\{ target/);
});

test("a selected framework is cleaned, built without Perry cache, and verified", () => {
  const calls = [];
  const removals = [];
  const stdout = outputSink();
  const dependencies = successfulDependencies({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return result(0, "compiled\n");
    },
    remove(target, options) {
      removals.push({ target, options });
    },
    stdout: stdout.stream,
  });

  runPerryFrameworkBuilds({ frameworkIds: ["solid"], platform: "linux", ...dependencies });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@nexa/example-solid-counter", "build"]);
  assert.equal(calls[0].options.env.PERRY_NO_CACHE, "1");
  assert.equal(
    calls[0].options.stdio,
    "inherit",
    "verbose native link output must stream instead of exhausting spawnSync's buffer",
  );
  assert.ok(removals.some(({ target }) => target.endsWith(path.join("solid-counter", "dist"))));
  assert.ok(
    removals.some(({ target }) => target.endsWith(path.join("solid-counter", "solid-counter"))),
  );
  assert.match(
    stdout.value(),
    new RegExp(`${PERRY_FRAMEWORK_MARKER} framework=solid platform=linux`),
  );
});

test("the Tier-1 Notes entry invokes its Solid application build", () => {
  const calls = [];
  const removals = [];
  runPerryFrameworkBuilds({
    frameworkIds: ["solid-notes"],
    platform: "linux",
    ...successfulDependencies({
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return result(0);
      },
      remove(target, options) {
        removals.push({ target, options });
      },
    }),
  });

  assert.deepEqual(calls[0].args, [
    "--filter",
    "@nexa/example-reference-notes",
    "solid:build",
  ]);
  assert.ok(
    removals.some(({ target }) => target.endsWith(path.join("reference-notes", "dist-solid"))),
  );
  assert.ok(
    removals.some(({ target }) =>
      target.endsWith(path.join("reference-notes", "reference-notes-solid")),
    ),
  );
});

test("the default matrix uses a controlled Windows shell and executable suffix", () => {
  const calls = [];
  const removals = [];
  const dependencies = successfulDependencies({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return result(0);
    },
    remove(target, options) {
      removals.push({ target, options });
    },
  });

  runPerryFrameworkBuilds({ platform: "win32", ...dependencies });

  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ command }) => command === "pnpm.cmd"));
  assert.ok(calls.every(({ options }) => options.shell === true));
  assert.ok(removals.some(({ target }) => target.endsWith("react-counter.exe")));
});

test("the matrix rejects unknown frameworks, failed builds, and missing output", () => {
  assert.throws(
    () =>
      runPerryFrameworkBuilds({
        frameworkIds: ["angular"],
        ...successfulDependencies(),
      }),
    /Unknown Perry framework: angular/,
  );
  assert.throws(
    () =>
      runPerryFrameworkBuilds({
        frameworkIds: ["vue"],
        ...successfulDependencies({ spawn: () => result(12, "", "compile failed") }),
      }),
    /Perry framework build failed for vue with exit code 12/,
  );
  assert.throws(
    () =>
      runPerryFrameworkBuilds({
        frameworkIds: ["react"],
        ...successfulDependencies({ exists: () => false }),
      }),
    /Perry framework build produced no executable for react/,
  );
});
