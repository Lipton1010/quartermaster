import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = ["scripts", "tests", "tools"];
const files = [];

function visit(path) {
  for (const name of readdirSync(path)) {
    const entry = join(path, name);
    if (statSync(entry).isDirectory()) visit(entry);
    else if (/\.(?:js|mjs)$/.test(name)) files.push(entry);
  }
}

for (const target of targets) {
  try { visit(join(root, target)); } catch { /* optional during early development */ }
}

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax check failed: ${relative(root, file)}`);
    console.error(result.stderr || result.stdout);
  }
}

if (failed) process.exit(1);
console.log(`Syntax OK: ${files.length} JavaScript files`);
