/**
 * Compile a limited Svelte component source into Host-oriented JS.
 * Full `svelte/internal` parity is not claimed — Counter/demo subset only.
 */

import { compile } from "svelte/compiler";

export type CompileOptions = {
  filename?: string;
};

export function compileToHost(source: string, options: CompileOptions = {}): string {
  const result = compile(source, {
    filename: options.filename ?? "Component.svelte",
    generate: "client",
    css: "external",
    compatibility: { componentApi: 4 },
  });

  let code = result.js.code;
  code = code.replace(
    /from\s+["']svelte\/(?:internal(?:\/[^"']*)?|legacy)["']/g,
    'from "@nexa/compiler-svelte/runtime"',
  );
  code = code.replace(/import\s+["']svelte\/internal(?:\/[^"']*)?["'];?\s*/g, "");
  code = code.replace(
    /from\s+["']svelte\/internal(?:\/[^"']*)?["']/g,
    'from "@nexa/compiler-svelte/runtime"',
  );
  code = code.replace(
    /from\s+["']svelte\/internal\.js["']/g,
    'from "@nexa/compiler-svelte/runtime"',
  );
  code = code.replace(/import\s+["']svelte\/internal\/disclose-version["'];?\s*/g, "");
  return code;
}
