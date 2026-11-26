// sous version and sous update: the version installed, and the upgrade through the package
// manager that installed it.

import { Refusal } from "@sous-run/engine";
import { reply, type Reply } from "../reply.js";
import type { Parsed } from "../args.js";
import type { Ctx } from "./index.js";

/** The name sous is published under on npm. */
const PACKAGE = "@sous-run/cli";

/** How this sous was installed, read from the path of its cli.js. */
type Install = "npm" | "pnpm" | "bun" | "yarn" | "source";

/** The way an installed cli.js was put on the machine. A cli.js outside node_modules is a build
 *  of the repository. */
function installOf(cliPath: string): Install {
  const path = cliPath.replaceAll("\\", "/").toLowerCase();
  if (!path.includes("/node_modules/")) return "source";
  if (path.includes("/.bun/")) return "bun";
  if (path.includes("/pnpm/") || path.includes("/.pnpm/")) return "pnpm";
  if (path.includes("/yarn/")) return "yarn";
  return "npm";
}

/** The command that installs the latest sous, or undefined for a build of the repository. */
function upgradeCommand(install: Install): string[] | undefined {
  switch (install) {
    case "npm":
      return ["npm", "install", "--global", `${PACKAGE}@latest`];
    case "pnpm":
      return ["pnpm", "add", "--global", `${PACKAGE}@latest`];
    case "bun":
      return ["bun", "add", "--global", `${PACKAGE}@latest`];
    case "yarn":
      return ["yarn", "global", "add", `${PACKAGE}@latest`];
    case "source":
      return undefined;
  }
}

/** The repository folder of a cli.js built from source: the folder that holds packages/cli. */
function repositoryOf(cliPath: string): string {
  const path = cliPath.replaceAll("\\", "/");
  const at = path.lastIndexOf("/packages/cli/");
  return at >= 0 ? path.slice(0, at) : path;
}

/** -1, 0 or 1 as version a is older than, the same as, or newer than b. A pre-release is older
 *  than its release. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function cmdVersion(_args: Parsed, ctx: Ctx): Reply<object> {
  const version = ctx.machine.version;
  const install = installOf(ctx.machine.cliPath);
  return reply({ version, install }, { text: [`sous ${version}`] });
}

/** sous update: install the latest version with the package manager that installed this one.
 *  --check only says whether a newer one is out. */
export async function cmdUpdate(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  const version = ctx.machine.version;
  const install = installOf(ctx.machine.cliPath);
  const command = upgradeCommand(install);
  const latest = await ctx.machine.latestVersion();
  if (latest === undefined) {
    throw new Refusal("no_registry", `sous could not read the latest version of ${PACKAGE} from the npm registry.`, "Check the network, then run it again.", "sous update --check --json");
  }
  const data = { version, latest, install, command: command?.join(" ") ?? null, updated: false };
  if (compareVersions(latest, version) <= 0) {
    return reply(data, { text: [`sous ${version} is the latest.`] });
  }
  if (command === undefined) {
    const repo = repositoryOf(ctx.machine.cliPath);
    return reply(data, {
      text: [`sous ${latest} is out. This sous ${version} is built from the repository at ${repo}.`, `Update it there: git pull, then pnpm install and pnpm build.`],
    });
  }
  if (args.flags.check === true) {
    return reply(data, {
      text: [`sous ${latest} is out. You have ${version}.`],
      next: [{ call: "sous update", does: `install it with ${command.join(" ")}` }],
    });
  }
  ctx.machine.err(`Installing sous ${latest}: ${command.join(" ")}`);
  const exit = await ctx.machine.run(command);
  if (exit !== 0) {
    throw new Refusal("update_failed", `${command.join(" ")} exited with ${exit}.`, "Read its output above, fix what it names, then run sous update again.", "sous update");
  }
  return reply({ ...data, updated: true }, { text: [`sous ${version} is now ${latest}.`] });
}
