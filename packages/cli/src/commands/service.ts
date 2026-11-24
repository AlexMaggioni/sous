// sous schedule and daemon: the service that starts runs on its own.

import { resolve } from "node:path";
import { cronMatches, daemonLog, daemonMain, daemonPid, fileSchedules, isPlace, loadSchedules, nextRun, parseCron, rememberProject, resolveWorkflow, saveSchedules, type Place, type Schedule } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { projectDir } from "./common.js";
import type { Ctx } from "./index.js";

export function cmdSchedule(args: Parsed, ctx: Ctx): number {
  const paths = ctx.paths;
  const dir = projectDir(args);
  const out = ctx.machine.out;
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
    throw new Error(`no schedule "${name}". sous schedule list shows them.`);
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
      if (resolved.extras.schedule) out(`note: ${resolved.name} also sets "${resolved.extras.schedule.cron}" in its meta, and both start it`);
      if (!daemonPid(paths)) out("the service is not running, so nothing will start: sous daemon start");
      return 0;
    }
    case "list":
    case undefined: {
      const all = [...schedules, ...inFiles];
      if (ctx.json) {
        out(JSON.stringify(all, null, 2));
        return 0;
      }
      if (!all.length) {
        out("no schedules");
        return 0;
      }
      for (const schedule of all) {
        const next = schedule.enabled ? nextRun(parseCron(schedule.cron)) : undefined;
        const when = schedule.enabled ? (next ? `next ${next.toLocaleString()}` : "") : "disabled";
        if (schedule.fromFile) out(`${tilde(schedule.workflow)}  ${schedule.cron}  set in the file  ${when}`);
        else out(`${schedule.name}  ${schedule.cron}  ${tilde(schedule.workflow)}  ${when}`);
      }
      if (!daemonPid(paths)) out("\nthe service is not running: sous daemon start");
      return 0;
    }
    case "remove":
      find();
      saveSchedules(paths, schedules.filter((schedule) => schedule.name !== name));
      out(`removed ${name}`);
      return 0;
    case "enable":
    case "disable":
      find().enabled = action === "enable";
      saveSchedules(paths, schedules);
      out(`${action}d ${name}`);
      return 0;
    case "test": {
      const schedule = find(true);
      const cron = parseCron(schedule.cron);
      out(`${tilde(schedule.name)} ${cronMatches(cron, ctx.now()) ? "matches" : "does not match"} now; next ${nextRun(cron)?.toLocaleString() ?? "never"}`);
      return 0;
    }
    default:
      throw new Usage("sous schedule add|list|remove|enable|disable|test");
  }
}

export async function cmdDaemon(args: Parsed, ctx: Ctx): Promise<number> {
  const { paths, machine } = ctx;
  const action = args.positional[0] ?? "status";
  const pid = daemonPid(paths);
  const log = daemonLog(paths);
  switch (action) {
    case "run":
      await daemonMain(paths, ctx.launch);
      return 0;
    case "start": {
      if (pid) {
        machine.out(`the service runs already (pid ${pid})`);
        return 0;
      }
      machine.out(`the service started (pid ${machine.spawnDaemon(paths)}). Log: ${log}`);
      return 0;
    }
    case "stop":
      if (!pid) {
        machine.out("the service is not running");
        return 0;
      }
      machine.kill(pid);
      machine.out(`stopping the service (pid ${pid})`);
      return 0;
    case "status":
      machine.out(pid ? `the service runs (pid ${pid}). Log: ${log}` : "the service is not running: sous daemon start");
      return pid ? 0 : 1;
    default:
      throw new Usage("sous daemon start|stop|status|run");
  }
}
