// Copies Herdr's API types (rewritten by the app on every start, so always this
// version's truth) into types/ for `npm run typecheck`.
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");

await mkdir(join(root, "types"), { recursive: true });
for (const file of ["gpui-kit.d.ts", "herdr.d.ts"]) {
  try {
    await copyFile(join(appHome, file), join(root, "types", file));
  } catch (e) {
    console.error(`cannot copy ${file} from ${appHome}: start the Herdr app once so it writes its types (${e.code})`);
    process.exit(1);
  }
}
console.log(`types copied from ${appHome}`);
