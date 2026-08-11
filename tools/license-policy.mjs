import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const allowed = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Python-2.0",
]);

function exceptions() {
  const source = readFileSync(path.join(root, "release", "license-exceptions.json"), "utf8");
  return JSON.parse(source).exceptions;
}

export function validateLicenses(report, today = new Date().toISOString().slice(0, 10)) {
  if (report.error) return [`pnpm license report failed: ${report.error.message ?? "unknown error"}`];
  const approved = exceptions();
  const failures = [];
  for (const [license, packages] of Object.entries(report)) {
    if (!Array.isArray(packages)) {
      failures.push(`invalid license report entry: ${license}`);
      continue;
    }
    for (const dependency of packages) {
      if (allowed.has(license)) continue;
      const exception = approved.find(
        (entry) =>
          entry.package === dependency.name &&
          entry.reportedLicense === license &&
          dependency.versions.every((version) => entry.versions.includes(version)),
      );
      if (!exception) {
        failures.push(`${dependency.name}@${dependency.versions.join(",")}: ${license}`);
      } else if (!/^@[^\s]+$/u.test(exception.owner) || exception.expiration < today) {
        failures.push(`${dependency.name}: expired or ownerless license exception`);
      }
    }
  }
  return failures;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const failures = validateLicenses({ "GPL-3.0-only": [{ name: "negative-fixture", versions: ["1.0.0"] }] });
    if (failures.length !== 1) throw new Error("license negative fixture did not fail");
    console.log("license negative fixture rejected");
    return;
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const failures = validateLicenses(JSON.parse(input));
  if (failures.length > 0) {
    console.error(`License policy failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("License policy ok");
  }
}

await main();
