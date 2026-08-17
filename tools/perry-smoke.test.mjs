import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PERRY_SMOKE_MARKER, runPerrySmoke } from "./perry-smoke.mjs";

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

test("the Perry smoke compiles then executes the generated native binary", () => {
  const calls = [];
  const stdout = outputSink();
  const stderr = outputSink();
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return calls.length === 1 ? result(0, "compiled\n") : result(0, `${PERRY_SMOKE_MARKER}\n`);
  };

  runPerrySmoke({ platform: "linux", spawn, stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].args, [
    "exec",
    "perry",
    "compile",
    "smoke.tsx",
    "-o",
    "perry-smoke",
    "--no-cache",
  ]);
  assert.equal(calls[1].command, path.join(calls[0].options.cwd, "perry-smoke"));
  assert.deepEqual(calls[1].args, []);
  assert.equal(calls[1].options.cwd, calls[0].options.cwd);
  assert.match(stdout.value(), new RegExp(PERRY_SMOKE_MARKER));
  assert.equal(stderr.value(), "");
});

test("the Perry smoke uses Windows command and executable names", () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return calls.length === 1 ? result(0) : result(0, PERRY_SMOKE_MARKER);
  };

  runPerrySmoke({
    platform: "win32",
    spawn,
    stdout: outputSink().stream,
    stderr: outputSink().stream,
  });

  assert.equal(calls[0].command, "pnpm.cmd");
  assert.deepEqual(calls[0].args.slice(-2), ["--windows-subsystem", "console"]);
  assert.equal(calls[1].command, path.join(calls[0].options.cwd, "perry-smoke.exe"));
});

test("the Perry smoke rejects a compile failure before executing a stale binary", () => {
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return result(17, "", "compile failed");
  };

  assert.throws(
    () =>
      runPerrySmoke({
        spawn,
        stdout: outputSink().stream,
        stderr: outputSink().stream,
      }),
    /Perry smoke compilation failed with exit code 17/,
  );
  assert.equal(calls, 1);
});

test("the Perry smoke requires a successful process and fixed marker", () => {
  const execute = (executionResult) => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls === 1 ? result(0) : executionResult;
    };
  };

  assert.throws(
    () =>
      runPerrySmoke({
        spawn: execute(result(9, "", "runtime failed")),
        stdout: outputSink().stream,
        stderr: outputSink().stream,
      }),
    /Perry smoke execution failed with exit code 9/,
  );
  assert.throws(
    () =>
      runPerrySmoke({
        spawn: execute(result(0, "unexpected output")),
        stdout: outputSink().stream,
        stderr: outputSink().stream,
      }),
    /did not emit the success marker/,
  );
});
