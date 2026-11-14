// Runs `herdr-app check` on every mod: loads it once and renders its first frame.
// Herdr's rule: never call a mod done without a passing check.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mods = (await readdir(join(root, "mods"), { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name.startsWith("wb-"))
  .map((d) => d.name)
  .sort();

let failed = 0;
for (const mod of mods) {
  const r = spawnSync("herdr-app", ["check", join(root, "mods", mod)], { encoding: "utf8" });
  if (r.error) { console.error(`herdr-app not found: ${r.error.message}`); process.exit(1); }
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "pass" : "FAIL"}  ${mod}`);
  if (!ok) console.log((r.stdout + r.stderr).trim().replace(/^/gm, "      "));
}
process.exit(failed ? 1 : 0);
