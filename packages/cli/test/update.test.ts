import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.js";
import type { Machine } from "../src/commands/index.js";

interface Fake {
  version?: string;
  cliPath?: string;
  latest?: string;
  exit?: number;
}

/** A machine with this version, install path and registry answer. It keeps what sous prints and
 *  the commands it runs. */
function fake({ version = "0.1.0", cliPath = "/usr/local/lib/node_modules/@sous-run/cli/dist/cli.js", latest, exit = 0 }: Fake) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const no = () => {
    throw new Error("the update test's machine does not do that");
  };
  const machine: Machine = {
    readText: no,
    exists: no,
    guideDir: "",
    skillDir: "",
    spawnDaemon: no,
    kill: no,
    sleep: no,
    version,
    cliPath,
    latestVersion: async () => latest,
    run: async (command) => {
      ran.push(command);
      return exit;
    },
    isTerminal: false,
    ask: no,
    open: no,
    untilStopped: no,
    out: (line) => out.push(line),
    write: (text) => out.push(text),
    err: (line) => err.push(line),
  };
  return { machine, out, err, ran };
}

/** Run sous with this fake machine, on a home of its own. */
async function sous(argv: string[], options: Fake) {
  const before = process.env.SOUS_HOME;
  process.env.SOUS_HOME = join(mkdtempSync(join(tmpdir(), "sous-update-")), "home");
  const f = fake(options);
  try {
    const code = await main(argv, { machine: f.machine });
    return { code, out: f.out.join("\n"), err: f.err.join("\n"), ran: f.ran };
  } finally {
    if (before === undefined) delete process.env.SOUS_HOME;
    else process.env.SOUS_HOME = before;
  }
}

/** What sous update --check --json says, with this sous at this path and this registry answer. */
async function check(options: Fake) {
  const result = await sous(["update", "--check", "--json"], options);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(result.ran, []);
  return JSON.parse(result.out) as { install: string; command: string | null; latest: string; updated: boolean };
}

describe("how sous was installed", () => {
  it("reads the package manager from the path of cli.js, and upgrades through it", async () => {
    const cases: Array<[string, string, string | null]> = [
      ["/usr/local/lib/node_modules/@sous-run/cli/dist/cli.js", "npm", "npm install --global @sous-run/cli@latest"],
      ["C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@sous\\cli\\dist\\cli.js", "npm", "npm install --global @sous-run/cli@latest"],
      ["/Users/a/Library/pnpm/global/5/.pnpm/@sous+cli@0.1.0/node_modules/@sous-run/cli/dist/cli.js", "pnpm", "pnpm add --global @sous-run/cli@latest"],
      ["/Users/a/.bun/install/global/node_modules/@sous-run/cli/dist/cli.js", "bun", "bun add --global @sous-run/cli@latest"],
      ["/Users/a/.config/yarn/global/node_modules/@sous-run/cli/dist/cli.js", "yarn", "yarn global add @sous-run/cli@latest"],
      ["/Users/a/Code/sous/packages/cli/dist/cli.js", "source", null],
    ];
    for (const [cliPath, install, command] of cases) {
      const reply = await check({ cliPath, version: "0.1.0", latest: "0.2.0" });
      assert.equal(reply.install, install, cliPath);
      assert.equal(reply.command, command, cliPath);
    }
  });
});

describe("versions", () => {
  it("orders versions by number, and a pre-release before its release", async () => {
    const newer: Array<[string, string]> = [
      ["0.1.9", "0.2.0"],
      ["0.9.0", "0.10.0"],
      ["1.0.0-rc.1", "1.0.0"],
      ["1.0.0-rc.1", "1.0.0-rc.2"],
    ];
    for (const [version, latest] of newer) {
      const result = await sous(["update", "--check"], { version, latest });
      assert.equal(result.out.split("\n")[0], `sous ${latest} is out. You have ${version}.`);
    }
    for (const [version, latest] of [["1.0.0", "1.0.0"], ["1.0.0", "v1.0.0"], ["0.10.0", "0.9.0"], ["1.0.0", "1.0.0-rc.1"]]) {
      const result = await sous(["update", "--check"], { version, latest });
      assert.equal(result.out, `sous ${version} is the latest.`, `${version} against ${latest}`);
    }
  });

  it("sous --version, -v and sous version print the version", async () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const result = await sous(argv, { version: "1.2.3" });
      assert.equal(result.code, 0);
      assert.equal(result.out, "sous 1.2.3");
    }
    const json = await sous(["version", "--json"], { version: "1.2.3" });
    assert.deepEqual(JSON.parse(json.out), { version: "1.2.3", install: "npm", notes: [], next: [] });
  });
});

describe("sous update", () => {
  it("runs nothing when this sous is the latest", async () => {
    const result = await sous(["update"], { version: "0.2.0", latest: "0.2.0" });
    assert.equal(result.code, 0);
    assert.equal(result.out, "sous 0.2.0 is the latest.");
    assert.deepEqual(result.ran, []);
  });

  it("with --check, says a newer one is out and runs nothing", async () => {
    const result = await sous(["update", "--check", "--json"], { version: "0.1.0", latest: "0.2.0" });
    assert.equal(result.code, 0);
    const reply = JSON.parse(result.out);
    assert.equal(reply.latest, "0.2.0");
    assert.equal(reply.command, "npm install --global @sous-run/cli@latest");
    assert.equal(reply.updated, false);
    assert.deepEqual(result.ran, []);
  });

  it("installs the newer one with the package manager that installed this one", async () => {
    const result = await sous(["update"], { version: "0.1.0", latest: "0.2.0", cliPath: "/Users/a/Library/pnpm/global/5/.pnpm/@sous+cli@0.1.0/node_modules/@sous-run/cli/dist/cli.js" });
    assert.equal(result.code, 0);
    assert.deepEqual(result.ran, [["pnpm", "add", "--global", "@sous-run/cli@latest"]]);
    assert.equal(result.out, "sous 0.1.0 is now 0.2.0.");
  });

  it("refuses with update_failed when the package manager fails", async () => {
    const result = await sous(["update", "--json"], { version: "0.1.0", latest: "0.2.0", exit: 1 });
    assert.equal(result.code, 66);
    assert.equal(JSON.parse(result.out).error.code, "update_failed");
  });

  it("refuses with no_registry when it can't read the latest version", async () => {
    const result = await sous(["update", "--json"], { version: "0.1.0" });
    assert.equal(result.code, 66);
    assert.equal(JSON.parse(result.out).error.code, "no_registry");
  });

  it("tells a build of the repository how to update, and runs nothing", async () => {
    const result = await sous(["update"], { version: "0.1.0", latest: "0.2.0", cliPath: "/Users/a/Code/sous/packages/cli/dist/cli.js" });
    assert.equal(result.code, 0);
    assert.deepEqual(result.ran, []);
    assert.match(result.out, /built from the repository at \/Users\/a\/Code\/sous/);
  });
});
