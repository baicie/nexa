import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const workflows = path.join(root, ".github", "workflows");

export function findUnpinnedActions(source, sourceName = "workflow") {
  const violations = [];
  for (const [index, line] of source.split("\n").entries()) {
    const match = line.match(/\buses:\s*([^\s#]+)/u);
    if (!match || match[1].startsWith("./")) continue;
    if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(match[1])) {
      violations.push(`${sourceName}:${index + 1}: ${match[1]}`);
    }
  }
  return violations;
}

const violations = [];
for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
  const source = readFileSync(path.join(workflows, file), "utf8");
  violations.push(...findUnpinnedActions(source, `.github/workflows/${file}`));
}

if (violations.length > 0) {
  console.error(`Action SHA policy failed:\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Action SHA policy ok");
}
