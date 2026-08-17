/**
 * Optional: compile Counter.svelte → dist/Counter.host.js via compileToHost.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileToHost } from "@nexa/compiler-svelte/compile";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "Counter.svelte"), "utf8");
const code = compileToHost(source, { filename: "Counter.svelte" });
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist/Counter.host.js"), code);
console.log("Wrote dist/Counter.host.js");
