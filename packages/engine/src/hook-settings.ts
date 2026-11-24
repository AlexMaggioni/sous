// The settings edit behind `sous hook install` and `sous hook remove`: pure functions from Claude
// Code's old settings to the new. programs.ts reads and writes the file.

/** The one command sous's hook runs. It prints the status line, or nothing, and never fails. */
export const HOOK_COMMAND = "sous status --line 2>/dev/null || true";

type Settings = Record<string, unknown>;
interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: string; command?: string }>;
}

const isObject = (value: unknown): value is Settings => typeof value === "object" && value !== null && !Array.isArray(value);

/** What makes settings a shape sous can't edit, or undefined when it can. */
function settingsProblem(settings: unknown): string | undefined {
  if (!isObject(settings)) return "is not a JSON object";
  if (settings.hooks === undefined) return undefined;
  if (!isObject(settings.hooks)) return "has a hooks key that is not an object";
  const start = settings.hooks.SessionStart;
  if (start !== undefined && !Array.isArray(start)) return "has a hooks.SessionStart key that is not a list";
  return undefined;
}

/** The SessionStart groups of settings whose shape settingsProblem passed. */
const groupsOf = (settings: Settings): unknown[] => ((settings.hooks as Settings | undefined)?.SessionStart as unknown[] | undefined) ?? [];

/** The group holds a command hook that runs command. */
const holds = (group: unknown, command: string): boolean => isObject(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => isObject(hook) && hook.command === command);

/**
 * Settings with one SessionStart group that runs command added at the end, or undefined when a
 * group runs it already. Pure: it copies what it changes. Throws on a shape it can't edit.
 */
export function withSessionHook(settings: unknown, command: string): Settings | undefined {
  const problem = settingsProblem(settings);
  if (problem) throw new Error(problem);
  const value = settings as Settings;
  if (groupsOf(value).some((group) => holds(group, command))) return undefined;
  const group: HookGroup = { hooks: [{ type: "command", command }] };
  return { ...value, hooks: { ...((value.hooks as Settings | undefined) ?? {}), SessionStart: [...groupsOf(value), group] } };
}

/**
 * Settings without command in any SessionStart group, or undefined when no group runs it. A group
 * left with no hooks goes, then SessionStart when it is empty, then hooks when it is empty, so a
 * remove after an install gives back what was there before. Throws on a shape it can't edit.
 */
export function withoutSessionHook(settings: unknown, command: string): Settings | undefined {
  const problem = settingsProblem(settings);
  if (problem) throw new Error(problem);
  const value = settings as Settings;
  if (!groupsOf(value).some((group) => holds(group, command))) return undefined;
  const groups = groupsOf(value).flatMap((group) => {
    if (!holds(group, command)) return [group];
    const left = (group as unknown as HookGroup).hooks.filter((hook) => !(isObject(hook) && hook.command === command));
    return left.length ? [{ ...(group as Settings), hooks: left }] : [];
  });
  const hooks: Settings = { ...(value.hooks as Settings), SessionStart: groups };
  if (!groups.length) delete hooks.SessionStart;
  const result: Settings = { ...value, hooks };
  if (!Object.keys(hooks).length) delete result.hooks;
  return result;
}
