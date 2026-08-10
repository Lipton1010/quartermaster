import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifactDir = join(root, "..", "..", "artifacts", "system-agnostic");
const artifact = join(artifactDir, "module.zip");
const bytes = readFileSync(artifact);

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
let eocd = -1;
for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
  if (bytes.readUInt32LE(offset) === EOCD) {
    eocd = offset;
    break;
  }
}
if (eocd < 0) throw new Error("module.zip has no ZIP end-of-central-directory record");

const totalEntries = bytes.readUInt16LE(eocd + 10);
let offset = bytes.readUInt32LE(eocd + 16);
const entries = [];
const entryMetadata = new Map();
for (let index = 0; index < totalEntries; index += 1) {
  if (bytes.readUInt32LE(offset) !== CENTRAL) throw new Error(`Invalid ZIP central entry ${index}`);
  const nameLength = bytes.readUInt16LE(offset + 28);
  const extraLength = bytes.readUInt16LE(offset + 30);
  const commentLength = bytes.readUInt16LE(offset + 32);
  const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
  entries.push(name);
  entryMetadata.set(name, {
    method: bytes.readUInt16LE(offset + 10),
    compressedSize: bytes.readUInt32LE(offset + 20),
    uncompressedSize: bytes.readUInt32LE(offset + 24),
    localOffset: bytes.readUInt32LE(offset + 42)
  });
  offset += 46 + nameLength + extraLength + commentLength;
}

const required = [
  "quartermaster/module.json",
  "quartermaster/scripts/module.js",
  "quartermaster/templates/inventory.hbs",
  "quartermaster/styles/module.css",
  "quartermaster/LICENSE"
];
const forbidden = [
  /(^|\/)\.git(?:\/|$)/,
  /(^|\/)node_modules(?:\/|$)/,
  /(^|\/)(?:tests|tools|test-data|artifacts|github|\.github)(?:\/|$)/,
  /(^|\/)package(?:-lock)?\.json$/,
  /(^|\/)test-step\d+\.js$/
];

const failures = [];
for (const name of required) if (!entries.includes(name)) failures.push(`missing ${name}`);
for (const name of entries) {
  if (!name.startsWith("quartermaster/")) failures.push(`entry outside module root: ${name}`);
  if (forbidden.some(pattern => pattern.test(name))) failures.push(`development entry in archive: ${name}`);
}

let archivedManifestBytes;
try {
  archivedManifestBytes = readEntry("quartermaster/module.json");
  const archivedManifest = JSON.parse(archivedManifestBytes.toString("utf8"));
  if (archivedManifest.id !== "quartermaster") failures.push("archived manifest id is not quartermaster");
  if (archivedManifest.version !== "1.0.0") failures.push("archived manifest version is not 1.0.0");
  if (!archivedManifest.download?.endsWith("/releases/download/v1.0.0/module.zip")) {
    failures.push("archived manifest download URL is not version-specific");
  }
  for (const script of archivedManifest.esmodules ?? []) {
    if (!entries.includes(`quartermaster/${script}`)) failures.push(`archived manifest script missing: ${script}`);
  }
} catch (error) {
  failures.push(`could not validate archived manifest: ${error.message}`);
}
if (failures.length) throw new Error(`Package integrity failed:\n${failures.join("\n")}`);

const sha256 = createHash("sha256").update(bytes).digest("hex");
const checksumPath = join(artifactDir, "module.zip.sha256");
const contentsPath = join(artifactDir, "module.zip.contents.txt");
const manifestPath = join(artifactDir, "module.json");
writeFileSync(checksumPath, `${sha256}  module.zip\n`, "utf8");
writeFileSync(contentsPath, `${entries.join("\n")}\n`, "utf8");
writeFileSync(manifestPath, archivedManifestBytes);

console.log(`Package integrity OK: ${entries.length} clean entries`);
console.log(`SHA-256: ${sha256}`);
console.log(`Evidence: ${checksumPath}`);
console.log(`Evidence: ${contentsPath}`);
console.log(`Manifest: ${manifestPath}`);

function readEntry(name) {
  const metadata = entryMetadata.get(name);
  if (!metadata) throw new Error(`missing ${name}`);
  const local = metadata.localOffset;
  if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(`invalid local header for ${name}`);
  const nameLength = bytes.readUInt16LE(local + 26);
  const extraLength = bytes.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + metadata.compressedSize);
  const content = metadata.method === 0
    ? Buffer.from(compressed)
    : metadata.method === 8 ? inflateRawSync(compressed) : null;
  if (!content) throw new Error(`unsupported ZIP method ${metadata.method} for ${name}`);
  if (content.length !== metadata.uncompressedSize) throw new Error(`size mismatch for ${name}`);
  return content;
}
