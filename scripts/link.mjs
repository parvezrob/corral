// Links this repo's mods and layouts into the Herdr app home, so the app runs
// them straight from here. Never replaces anything that isn't already our link.
//
//   node scripts/link.mjs           link mods/wb-* and layouts/*.json
//   node scripts/link.mjs --remove  remove those links again
import { readdir, lstat, readlink, symlink, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const remove = process.argv.includes("--remove");

const mods = (await readdir(join(root, "mods"), { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name.startsWith("wb-"))
  .map((d) => [join(root, "mods", d.name), join(appHome, "mods", d.name)]);
const layouts = (await readdir(join(root, "layouts")))
  .filter((f) => f.endsWith(".json") || f.endsWith(".svg"))
  .map((f) => [join(root, "layouts", f), join(appHome, "layouts", f)]);

let problems = 0;
for (const [source, target] of [...mods, ...layouts]) {
  const info = await lstat(target).catch(() => null);
  const ours = info?.isSymbolicLink() && (await readlink(target)) === source;
  if (remove) {
    if (ours) { await unlink(target); console.log(`removed ${target}`); }
    continue;
  }
  if (ours) continue;
  if (info) { console.error(`skipped ${target}: something else is there`); problems++; continue; }
  await mkdir(join(target, ".."), { recursive: true });
  await symlink(source, target);
  console.log(`linked  ${target}`);
}
process.exit(problems ? 1 : 0);
