#!/usr/bin/env node

import { runCli } from "./index.mjs";

process.exitCode = runCli(process.argv.slice(2));
