// Copies the shared lib/ into every mod folder (mods/wb-*/lib/).
//
// Herdr resolves a mod's imports only inside its own folder (a symlink pointing out
// is refused too), and a mod published to herdr.dev must stand alone. So each mod
// carries its own copy, generated from lib/ here. Edit lib/, never a copy.
//
//   node scripts/build.mjs          write the copies
//   node scripts/build.mjs --check  exit 1 if any copy is missing or stale
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const banner = (file) => `// Generated from lib/${file} by scripts/build.mjs. Edit the source, not this copy.\n`;

const sources = (await readdir(join(root, "lib"))).filter((f) => f.endsWith(".js")).sort();
const mods = (await readdir(join(root, "mods"), { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name.startsWith("wb-"))
  .map((d) => d.name)
  .sort();

let stale = 0;
for (const mod of mods) {
  const dir = join(root, "mods", mod, "lib");
  // Herdr writes its own gpui-kit.d.ts and jsconfig.json into mod folders: not ours to manage.
  const existing = new Set((await readdir(dir).catch(() => [])).filter((f) => f !== "gpui-kit.d.ts" && f !== "jsconfig.json"));
  for (const file of sources) {
    const want = banner(file) + (await readFile(join(root, "lib", file), "utf8"));
    const have = await readFile(join(dir, file), "utf8").catch(() => null);
    existing.delete(file);
    if (have === want) continue;
    stale++;
    if (check) { console.error(`stale: mods/${mod}/lib/${file}`); continue; }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), want);
  }
  for (const leftover of existing) {
    stale++;
    if (check) { console.error(`leftover: mods/${mod}/lib/${leftover}`); continue; }
    await rm(join(dir, leftover));
  }
}

if (check && stale) process.exit(1);
console.log(`${check ? "checked" : "built"} ${sources.length} lib files into ${mods.length} mods${check ? "" : `, ${stale} written or removed`}`);
