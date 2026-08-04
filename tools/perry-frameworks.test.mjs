import assert from "node:assert/strict";
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

test("the Perry framework matrix has exactly the four planned Counter examples", () => {
  assert.deepEqual(PERRY_FRAMEWORKS, [
    {
      id: "solid",
      packageName: "@nexa/example-solid-counter",
      directory: "solid-counter",
      output: "solid-counter",
      clean: ["dist"],
    },
    {
      id: "vue",
      packageName: "@nexa/example-vue-counter",
      directory: "vue-counter",
      output: "vue-counter",
      clean: [],
    },
    {
      id: "react",
      packageName: "@nexa/example-react-counter",
      directory: "react-counter",
      output: "react-counter",
      clean: [],
    },
    {
      id: "svelte",
      packageName: "@nexa/example-svelte-counter",
      directory: "svelte-counter",
      output: "svelte-counter",
      clean: [],
    },
  ]);
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

  assert.equal(calls.length, 4);
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
