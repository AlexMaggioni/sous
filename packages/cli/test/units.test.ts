import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parseArgs, parseSets } from "../src/args.js";
import { COMMANDS } from "../src/commands/index.js";
import { capture } from "./sous.js";

describe("command line", () => {
  it("keeps sous's flags apart from the workflow's inputs", () => {
    const parsed = parseArgs(["ticket", "--place", "none", "--ticket", "add a flag", "--wait", "--set", "reviewer.model=claude/opus", "--", "--place", "x"], COMMANDS.run!.flags, true);
    assert.deepEqual(parsed.positional, ["ticket"]);
    assert.deepEqual(parsed.flags, { place: "none", wait: true, set: ["reviewer.model=claude/opus"] });
    assert.deepEqual(parsed.inputs, { ticket: "add a flag", place: "x" });
    assert.deepEqual(parseSets(parsed.flags.set as string[]), { reviewer: { model: "claude/opus" } });
    assert.deepEqual(parseSets(["a.b.retries=2", "x.schema={\"type\":\"object\"}"]), { "a.b": { retries: 2 }, x: { schema: { type: "object" } } });
    assert.throws(() => parseSets(["nokey=1"]), /label\.key=value/);
  });
});

// The split cli: parseArgs and RESERVED in args.ts, the COMMANDS table in commands/index.ts. Each
// test loads them itself, so the test above still runs while they are missing.
const args = () => import("../src/args.js");
const commands = () => import("../src/commands/index.js");

/** The commands that take workflow inputs, with the flags each owns. */
async function inputCommands() {
  const { COMMANDS } = await commands();
  return Object.entries(COMMANDS).filter(([, command]) => command.inputs === true);
}

describe("split command line", () => {
  it("puts an unknown --name value of sous run into inputs, and its own --json into flags", async () => {
    const { parseArgs } = await args();
    const { COMMANDS } = await commands();
    const RUN_FLAGS = COMMANDS.run!.flags;
    const parsed = parseArgs(["deploy", "--env", "prod", "--json"], RUN_FLAGS, true);
    assert.deepEqual(parsed.positional, ["deploy"]);
    assert.deepEqual(parsed.inputs, { env: "prod" });
    assert.equal(parsed.flags.json, true);
  });

  it("run, rerun and check take inputs", async () => {
    const names = (await inputCommands()).map(([name]) => name);
    for (const name of ["run", "rerun", "check"]) assert.ok(names.includes(name), `COMMANDS.${name} has no inputs: true`);
  });

  it("RESERVED holds every flag of a command that takes inputs, and the new ones", async () => {
    const { RESERVED } = await args();
    for (const [name, command] of await inputCommands()) {
      for (const flag of command.flags) assert.ok(RESERVED.includes(flag.name), `--${flag.name} of sous ${name} is not in RESERVED`);
    }
    for (const name of ["by", "budget", "timeout", "note", "let-agent-answer"]) assert.ok(RESERVED.includes(name), `--${name} is not in RESERVED`);
  });

  it("a command's own flags never become inputs", async () => {
    const { parseArgs } = await args();
    for (const [name, command] of await inputCommands()) {
      for (const flag of command.flags) {
        const argv = flag.takes === "none" ? ["wf", `--${flag.name}`] : ["wf", `--${flag.name}`, "value"];
        const parsed = parseArgs(argv, command.flags, true);
        assert.ok(!Object.hasOwn(parsed.inputs, flag.name), `sous ${name} --${flag.name} became an input`);
        assert.ok(Object.hasOwn(parsed.flags, flag.name), `sous ${name} --${flag.name} is not in flags`);
      }
    }
  });

  it("every name in RESERVED stays out of inputs", async () => {
    const { parseArgs, RESERVED } = await args();
    assert.ok(RESERVED.length > 0, "RESERVED is empty");
    for (const [name, command] of await inputCommands()) {
      for (const reserved of RESERVED) {
        let parsed;
        try {
          parsed = parseArgs(["wf", `--${reserved}`, "value"], command.flags, true);
        } catch (error) {
          // A usage refusal keeps it out too. A bug in the parser does not count.
          assert.ok(!(error instanceof TypeError || error instanceof ReferenceError), `sous ${name} --${reserved}: ${(error as Error).message}`);
          continue;
        }
        assert.ok(!Object.hasOwn(parsed.inputs, reserved), `sous ${name} --${reserved} became an input`);
      }
    }
  });

  it("every command in COMMANDS appears in sous help", async () => {
    const { COMMANDS } = await commands();
    const { main } = await import("../src/cli.js");
    const printed: string[] = [];
    const restore = capture(printed);
    let code: number;
    try {
      code = await main(["help"]);
    } finally {
      restore();
    }
    assert.equal(code, 0);
    const help = printed.join("");
    const names = Object.keys(COMMANDS);
    assert.ok(names.length > 0, "COMMANDS is empty");
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(help, new RegExp(`^\\s*sous ${escaped}(\\s|$)`, "m"), `sous help does not list sous ${name}`);
    }
  });
});

/** A machine that keeps what sous prints, and fails on anything else. */
function printer() {
  const out: string[] = [];
  const err: string[] = [];
  const no = () => {
    throw new Error("the fake machine does only out and err");
  };
  const machine = { readText: no, exists: no, guideDir: "", skillDir: "", spawnDaemon: no, kill: no, sleep: no, isTerminal: false, ask: no, out: (line: string) => out.push(line), write: (text: string) => out.push(text), err: (line: string) => err.push(line) };
  return { machine, out, err };
}

/** Runs main with SOUS_HOME on a folder that does not exist yet, and says if main made it. */
async function onNoHome(argv: string[]) {
  const { main } = await import("../src/cli.js");
  const home = join(mkdtempSync(join(tmpdir(), "sous-refuse-")), "home");
  const before = process.env.SOUS_HOME;
  process.env.SOUS_HOME = home;
  const printed = printer();
  try {
    const code = await main(argv, { machine: printed.machine });
    return { code, out: printed.out, err: printed.err, madeHome: existsSync(home) };
  } finally {
    if (before === undefined) delete process.env.SOUS_HOME;
    else process.env.SOUS_HOME = before;
  }
}

describe("refused flags", () => {
  it("sous run refuses a sous flag it does not take, prints usage and makes no home", async () => {
    const result = await onNoHome(["run", "wf", "--days", "3"]);
    assert.equal(result.code, 64);
    assert.ok(result.err.some((line) => line.startsWith("usage:")), `no usage line on stderr: ${JSON.stringify(result.err)}`);
    const message = result.err.join("\n");
    assert.match(message, /sous run does not take --days/);
    assert.match(message, /--place/);
    assert.match(message, /sous run wf -- --days 3/);
    assert.equal(result.madeHome, false);
  });

  it("takes the same name as an input after --", () => {
    assert.deepEqual(parseArgs(["wf", "--", "--days", "3"], COMMANDS.run!.flags, true).inputs, { days: "3" });
  });

  it("prints help before it refuses a flag", async () => {
    const result = await onNoHome(["run", "--help", "--yes"]);
    assert.equal(result.code, 0);
    assert.match(result.out.join(""), /^\s*sous run(\s|$)/m);
    assert.deepEqual(result.err, []);
    assert.equal(result.madeHome, false);
  });
});

describe("test home", () => {
  const MARKERS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID"];

  it("clears the session markers for the tests it runs", () => {
    for (const name of MARKERS) assert.equal(process.env[name], undefined, `${name} is set under the wrapper`);
  });

  it("clears the session markers even when the shell that starts it has them", () => {
    const wrapper = fileURLToPath(new URL("../../../test/with-temp-home.mjs", import.meta.url));
    const env = { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s-1", CODEX_THREAD_ID: "t-1", SOUS_RUN_ID: "r-1" };
    const show = `process.stdout.write(JSON.stringify(${JSON.stringify(MARKERS)}.filter((name) => process.env[name] !== undefined)))`;
    const child = spawnSync(process.execPath, [wrapper, process.execPath, "-e", show], { env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), []);
  });
});
