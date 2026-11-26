import { describe, expect, test } from "vitest";
import type { RunRow } from "../src/api/contract.ts";
import { shortAge } from "../src/format.ts";
import { matches } from "../src/lists/filter.ts";
import { groupRuns, hasEnded, needsPerson, pickRuns, runMeta } from "../src/lists/run-groups.ts";

const SHOP = { dir: "/work/shop", name: "shop" };
const PARSER = { dir: "/work/parser", name: "parser" };

/** A run that started `minutes` after 9:00, done in the shop project unless `more` says otherwise. */
function run(id: string, minutes: number, more: Partial<RunRow> = {}): RunRow {
  return {
    id,
    workflow: id,
    title: id,
    project: SHOP,
    status: "done",
    statusText: "Done",
    startedAt: new Date(Date.UTC(2026, 10, 25, 9, minutes)).toISOString(),
    tokens: 0,
    waiting: 0,
    origin: "cli",
    ...more,
  };
}

const ids = (groups: ReturnType<typeof groupRuns>) => groups.map((g) => [g.label, g.items.map((r) => r.id)]);

describe("grouping by status", () => {
  test("puts what needs the person first, then failed, running, queued, paused and done", () => {
    const runs = [
      run("done-1", 1),
      run("paused", 2, { status: "paused" }),
      run("asks", 3, { status: "running", waiting: 1 }),
      run("queued", 4, { status: "queued" }),
      run("running", 5, { status: "running" }),
      run("failed", 6, { status: "failed" }),
      run("needs", 7, { status: "needs" }),
      run("stopped", 8, { status: "stopped" }),
    ];
    expect(ids(groupRuns(runs, "status"))).toEqual([
      ["Needs you", ["needs", "asks"]],
      ["Failed", ["failed"]],
      ["Running", ["running"]],
      ["Queued", ["queued"]],
      ["Paused", ["paused"]],
      ["Done", ["stopped", "done-1"]],
    ]);
  });

  test("marks only the Needs you group, and leaves out empty groups", () => {
    const groups = groupRuns([run("a", 1), run("b", 2, { status: "needs" })], "status");
    expect(groups.map((g) => [g.key, g.needs])).toEqual([
      ["needs", true],
      ["done", false],
    ]);
  });

  test("orders newest first, and by id when two runs started at once", () => {
    const groups = groupRuns([run("b", 5), run("c", 9), run("a", 5)], "status");
    expect(groups[0]?.items.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("grouping by project", () => {
  test("puts the runs that need the person first in each project, then the newest", () => {
    const groups = groupRuns([run("old-asks", 1, { status: "needs" }), run("new", 9), run("mid", 5)], "project");
    expect(ids(groups)).toEqual([["shop", ["old-asks", "new", "mid"]]]);
  });

  test("puts a project with a run that needs the person before one with newer runs", () => {
    const groups = groupRuns([run("p-new", 9, { project: PARSER }), run("s-asks", 1, { waiting: 2 })], "project");
    expect(ids(groups)).toEqual([
      ["shop", ["s-asks"]],
      ["parser", ["p-new"]],
    ]);
  });

  test("otherwise puts the project with the newest run first", () => {
    const groups = groupRuns([run("s", 3), run("p", 7, { project: PARSER })], "project");
    expect(groups.map((g) => g.key)).toEqual(["p:/work/parser", "p:/work/shop"]);
  });

  test("labels two projects of one name with their folders", () => {
    const other = { dir: "/forks/shop", name: "shop" };
    const groups = groupRuns([run("a", 1), run("b", 2, { project: other }), run("c", 3, { project: PARSER })], "project");
    expect(groups.map((g) => g.label)).toEqual(["parser", "/forks/shop", "/work/shop"]);
  });
});

describe("the runs a list shows", () => {
  const runs = [
    run("r-1", 1, { title: "Fix the tests", workflow: "fix-tests" }),
    run("r-2", 2, { title: "Ship it", workflow: "release", project: PARSER, status: "paused", statusText: "Paused, budget" }),
    run("r-3", 3, { title: "Review", workflow: "review" }),
  ];
  const shown = (options: Parameters<typeof pickRuns>[1]) => pickRuns(runs, options).map((r) => r.id);

  test("finds every word in any order, any case, across title, workflow, project, id and status", () => {
    expect(shown({ query: "SHOP fix" })).toEqual(["r-1"]);
    expect(shown({ query: "release" })).toEqual(["r-2"]);
    expect(shown({ query: "parser budget" })).toEqual(["r-2"]);
    expect(shown({ query: "r-3" })).toEqual(["r-3"]);
    expect(shown({ query: "fix parser" })).toEqual([]);
  });

  test("shows every run for an empty search, less the removed ones and other projects", () => {
    expect(shown({ query: "  " })).toEqual(["r-1", "r-2", "r-3"]);
    expect(shown({ hidden: new Set(["r-1"]) })).toEqual(["r-2", "r-3"]);
    expect(shown({ project: PARSER.dir })).toEqual(["r-2"]);
  });

  test("matches ignores empty texts and needs every word", () => {
    expect(matches([undefined, "Draft release notes"], "notes draft")).toBe(true);
    expect(matches(["Draft release notes"], "notes review")).toBe(false);
    expect(matches([], "")).toBe(true);
  });
});

describe("a row's words", () => {
  test("shows the workflow only when it differs from the title, and the project when asked", () => {
    expect(runMeta(run("greet", 1), { withProject: false })).toBe("");
    expect(runMeta(run("x", 1, { title: "Hello", workflow: "greet" }), { withProject: false })).toBe("greet");
    expect(runMeta(run("x", 1, { title: "Hello", workflow: "greet" }), { withProject: true })).toBe("greet, shop");
  });

  test("gives a short age: now, minutes, hours, then the date", () => {
    const at = "2026-11-25T09:00:00.000Z";
    const t = Date.parse(at);
    expect(shortAge(at, t + 30_000)).toBe("now");
    expect(shortAge(at, t + 3 * 60_000)).toBe("3m");
    expect(shortAge(at, t + 5 * 3_600_000)).toBe("5h");
    expect(shortAge(at, t + 3 * 86_400_000)).not.toMatch(/^\d+[mh]$|^now$/);
  });

  test("a run waits on the person by its status or its open questions, and a paused run has not ended", () => {
    expect(needsPerson(run("a", 1, { status: "running", waiting: 1 }))).toBe(true);
    expect(needsPerson(run("a", 1, { status: "running" }))).toBe(false);
    expect(hasEnded(run("a", 1, { status: "paused" }))).toBe(false);
    expect(hasEnded(run("a", 1, { status: "stopped" }))).toBe(true);
    expect(hasEnded(run("a", 1, { status: "running", endedAt: "2026-11-25T10:00:00.000Z" }))).toBe(true);
  });
});
