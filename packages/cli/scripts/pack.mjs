// Before npm packs @sous/cli, copy in what the package carries from outside its folder: the built
// page of sous serve, and the README, LICENSE and NOTICE of the repository. After the pack,
// `node scripts/pack.mjs clean` removes the copies, so a build of the repository keeps taking the
// page from packages/view.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(cli, "..", "..");
const COPIES = [
  [join(cli, "..", "view", "dist"), join(cli, "view")],
  [join(root, "README.md"), join(cli, "README.md")],
  [join(root, "LICENSE"), join(cli, "LICENSE")],
  [join(root, "NOTICE"), join(cli, "NOTICE")],
];

if (process.argv[2] === "clean") {
  for (const [, to] of COPIES) rmSync(to, { recursive: true, force: true });
} else {
  if (!existsSync(join(cli, "dist", "cli.js"))) throw new Error("packages/cli is not built. Run pnpm build first.");
  if (!existsSync(join(cli, "..", "view", "dist", "index.html"))) throw new Error("the page is not built. Run pnpm build first.");
  for (const [from, to] of COPIES) {
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
}
