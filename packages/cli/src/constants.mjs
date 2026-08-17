export const COMPATIBILITY = Object.freeze({
  cli: "0.1.0",
  node: ">=22",
  pnpm: "10.34.3",
  perry: "0.5.1220",
  typescript: "5.9.2",
  protocol: "1.0.0",
  ui: "0.1.0",
  hostRuntime: "0.1.0",
  hostAbi: "0.5",
});

export const PERRY_SOURCE_REPOSITORY = "https://github.com/PerryTS/perry";
export const PERRY_SOURCE_REVISION = "06137858dc8c6f80975238377138f2f948d6ef88";

export const NEXA_COMPILE_PACKAGES = Object.freeze([
  "@nexa/ui",
  "@nexa/fs",
  "@nexa/dialog",
  "@nexa/clipboard",
  "@nexa/protocol",
  "@nexa/nui-host",
  "@nexa/system-host",
]);

export const APP_MANIFEST_SCHEMA = "https://nexa-ui.dev/schema/app-manifest-v1.json";
export const APP_MANIFEST_MAX_BYTES = 64 * 1024;
export const APP_MANIFEST_PROTOCOL = Object.freeze({ major: 1, minor: 0 });
export const APP_MANIFEST_PERMISSIONS = Object.freeze([
  "system.ClipboardRead",
  "system.ClipboardWrite",
  "system.DialogOpen",
  "system.DialogSave",
  "system.FsRead",
  "system.FsWrite",
]);
