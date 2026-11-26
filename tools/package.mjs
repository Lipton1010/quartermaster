import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifact = join(root, "..", "..", "artifacts", "system-agnostic", "module.zip");

const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.status !== 0) {
  console.error(status.stderr || status.stdout);
  process.exit(status.status ?? 1);
}
if (status.stdout.trim()) {
  console.error("Refusing to package an uncommitted tree. Commit and re-run the release checks first.");
  process.exit(1);
}
mkdirSync(dirname(artifact), { recursive: true });
rmSync(artifact, { force: true });

const result = spawnSync("git", ["archive", "--format=zip", "--prefix=quartermaster/", `--output=${artifact}`, "HEAD"], {
  cwd: root,
  encoding: "utf8"
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}
console.log(artifact);
