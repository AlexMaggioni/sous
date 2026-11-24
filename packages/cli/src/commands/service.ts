// sous schedule and daemon: the service that starts runs on its own.

import { resolve } from "node:path";
import { cronMatches, daemonLog, daemonMain, daemonPid, fileSchedules, isPlace, loadSchedules, nextRun, parseCron, Refusal, rememberProject, resolveWorkflow, saveSchedules, type Place, type Schedule } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { reply, type Next, type Reply } from "../reply.js";
import { projectDir } from "./common.js";
import type { Ctx } from "./index.js";

export function cmdSchedule(args: Parsed, ctx: Ctx): Reply<object> {
  const paths = ctx.paths;
  const dir = projectDir(args);
  const text: string[] = [];
  const out = (line: string) => text.push(line);
  // With --json the text is left out, so each action gives what it did as data.
  const done = (data: object = {}, notes: string[] = []) => reply(data, { text, notes: ctx.json ? notes : [] });
  const [action, name, workflow] = args.positional;
  const schedules = loadSchedules(paths);
  if (action === "list" || action === undefined || action === "test") rememberProject(paths, dir);
  const inFiles = fileSchedules(paths);
  const home = ctx.env.HOME;
  const tilde = (path: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);
  const find = (all = false) => {
    const found = schedules.find((schedule) => schedule.name === name) ?? (all ? inFiles.find((schedule) => schedule.name === resolve(name ?? "")) : undefined);
    if (found) return found;
    const fromFile = inFiles.find((schedule) => schedule.name === resolve(name ?? ""));
    if (fromFile) throw new Error(`the schedule of ${tilde(fromFile.workflow)} is set in its meta. Change or remove meta.schedule there.`);
    throw new Refusal("no_such_schedule", `no schedule "${name}".`, "Name a schedule that sous schedule list shows.", "sous schedule list --json");
  };
  switch (action) {
    case "add": {
      const cron = str(args.flags.cron);
      if (!name || !workflow || !cron) throw new Usage('sous schedule add <name> <workflow> --cron "0 9 * * 1-5" [--name value ...]');
      if (schedules.some((schedule) => schedule.name === name)) throw new Error(`a schedule "${name}" exists. Remove it first.`);
      parseCron(cron);
      const resolved = resolveWorkflow(paths, dir, workflow);
      const place = str(args.flags.place);
      if (place !== undefined && !isPlace(place)) throw new Usage(`--place is worktree, folder or none, got "${place}"`);
      const schedule: Schedule = {
        name,
        workflow: resolved.file,
        projectDir: dir,
        cron,
        inputs: args.inputs,
        ...(place ? { place: place as Place } : {}),
        enabled: true,
        createdAt: ctx.now().toISOString(),
      };
      saveSchedules(paths, [...schedules, schedule]);
      const next = nextRun(parseCron(cron));
      out(`schedule ${name}: ${resolved.name} at "${cron}"${next ? `, next ${next.toLocaleString()}` : ""}`);
      const notes: string[] = [];
      if (resolved.extras.schedule) {
        notes.push(`${resolved.name} also sets "${resolved.extras.schedule.cron}" in its meta, and both start it`);
        out(`note: ${notes.at(-1)}`);
      }
      if (!daemonPid(paths)) {
        notes.push("the service is not running, so nothing will start: sous daemon start");
        out(notes.at(-1)!);
      }
      return done({ schedule, nextAt: next?.toISOString() }, notes);
    }
    case "list":
    case undefined: {
      const all = [...schedules, ...inFiles];
      if (ctx.json) return reply({ schedules: all });
      if (!all.length) {
        out("no schedules");
        return done();
      }
      for (const schedule of all) {
        const next = schedule.enabled ? nextRun(parseCron(schedule.cron)) : undefined;
        const when = schedule.enabled ? (next ? `next ${next.toLocaleString()}` : "") : "disabled";
        if (schedule.fromFile) out(`${tilde(schedule.workflow)}  ${schedule.cron}  set in the file  ${when}`);
        else out(`${schedule.name}  ${schedule.cron}  ${tilde(schedule.workflow)}  ${when}`);
      }
      if (!daemonPid(paths)) out("\nthe service is not running: sous daemon start");
      return done();
    }
    case "remove":
      find();
      saveSchedules(paths, schedules.filter((schedule) => schedule.name !== name));
      out(`removed ${name}`);
      return done({ removed: name });
    case "enable":
    case "disable":
      find().enabled = action === "enable";
      saveSchedules(paths, schedules);
      out(`${action}d ${name}`);
      return done({ name, enabled: action === "enable" });
    case "test": {
      const schedule = find(true);
      const cron = parseCron(schedule.cron);
      const matches = cronMatches(cron, ctx.now());
      const next = nextRun(cron);
      out(`${tilde(schedule.name)} ${matches ? "matches" : "does not match"} now; next ${next?.toLocaleString() ?? "never"}`);
      return done({ name: schedule.name, matches, nextAt: next?.toISOString() });
    }
    default:
      throw new Usage("sous schedule add|list|remove|enable|disable|test");
  }
}

export async function cmdDaemon(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  const { paths, machine } = ctx;
  const action = args.positional[0] ?? "status";
  const pid = daemonPid(paths);
  const log = daemonLog(paths);
  // The text line says it all, so notes are for --json alone.
  const said = (line: string, running: number | null, notes: string[] = [], next: Next[] = []) =>
    reply({ running: running !== null, pid: running, log }, { text: [line], notes: ctx.json ? notes : [], next });
  const start: Next = { call: "sous daemon start --json", does: "starts the service" };
  switch (action) {
    case "run":
      await daemonMain(paths, ctx.launch);
      return reply({});
    case "start": {
      if (pid) return said(`the service runs already (pid ${pid})`, pid, ["the service runs already, so nothing started."]);
      const started = machine.spawnDaemon(paths);
      return said(`the service started (pid ${started}). Log: ${log}`, started ?? null);
    }
    case "stop":
      if (!pid) return said("the service is not running", null, ["the service is not running, so nothing stops."]);
      machine.kill(pid);
      return said(`stopping the service (pid ${pid})`, pid, ["the service got SIGTERM and stops in a moment."], [{ call: "sous daemon status --json", does: "says whether the service still runs" }]);
    case "status":
      // A service that does not run is a state, not a failure.
      return pid ? said(`the service runs (pid ${pid}). Log: ${log}`, pid) : said("the service is not running: sous daemon start", null, ["the service is not running"], [start]);
    default:
      throw new Usage("sous daemon start|stop|status|run");
  }
}
