import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
JSON.parse(readFileSync(join(root, "lang", "en.json"), "utf8"));

const failures = [];
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
  failures.push("module.json version must be semantic");
}
if (manifest.relationships?.systems?.length) failures.push("module.json must not restrict supported systems");
if (!manifest.download?.includes(`/releases/download/v${manifest.version}/module.zip`)) {
  failures.push("module.json download URL must be version-specific");
}

for (const required of ["scripts/module.js", "templates/inventory.hbs", "styles/module.css", "LICENSE"]) {
  try { statSync(join(root, ...required.split("/"))); }
  catch { failures.push(`missing release file: ${required}`); }
}

const productionFiles = [];
function visit(path) {
  for (const name of readdirSync(path)) {
    const entry = join(path, name);
    if (statSync(entry).isDirectory()) visit(entry);
    else if (name.endsWith(".js") && !/^test-step\d+\.js$/.test(name)) productionFiles.push(entry);
  }
}
visit(join(root, "scripts"));

const adapterSegment = `${join("scripts", "system-adapters")}`.toLowerCase();
const forbidden = [
  /actor\.system\?*\.currency|system\.currency\./,
  /(?:actor|item)\??\.system\??\.(?:quantity|weight|price|identified|unidentified)\b/,
  /flags\??\.dnd5e\b/,
  /actor\.type\s*[!=]==?\s*["']character["']/,
  /type:\s*["']npc["']/,
  /(?:actor|item)\.type\s*[!=]==?\s*["'](?:loot|character|npc)["']/,
  /\.includes\(["']loot["']\)/
];
for (const file of productionFiles) {
  const normalized = file.toLowerCase();
  if (normalized.includes(adapterSegment)) continue;
  const source = readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(source)) failures.push(`system-specific path outside adapter: ${file}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Release metadata and system-boundary checks passed");
