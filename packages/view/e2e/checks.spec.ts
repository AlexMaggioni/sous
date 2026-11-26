// The end-to-end checks of the page: a real `sous serve` on the throwaway world of serve.mjs, in
// Chrome. Each check drives the page by role and name, as a person would, and looks at what the
// person sees. The checks share one server and one world, so each starts the runs it changes,
// from a terminal or from the page, and finds them by a title no other run has.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRow } from "../src/api/contract.ts";
import { TOKEN } from "../playwright.config.ts";
import { api, expectNoReload, fact, markPage, openPage, runRow, runsList, sous, startRun, stopRun, theWorld, toast, unique, waitForRun } from "./sous.ts";
import type { World } from "./world.mjs";

const main = (page: Page) => page.getByRole("main");
/** The run's status in its header, such as "Needs you" or "Done". */
const headerStatus = (page: Page, word: string) => main(page).getByText(word, { exact: true }).first();
const viewSwitch = (page: Page) => page.getByRole("radiogroup", { name: "View" });

/** Start a greet run from the terminal, with a greeting no other run has as its title. */
function greetRun(world: World, word = "Howdy"): { id: string; title: string } {
  const title = unique(word);
  return { id: startRun(world, "greet", { greeting: title }), title };
}

/** A slow run paused during its one-second warm up, from the terminal. The pause lands once the
 *  worker runs. When the warm up ends first, the long step starts, so the check stops that run and
 *  tries a fresh one. */
async function pausedSlowRun(world: World, request: APIRequestContext): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = startRun(world, "slow");
    await waitForRun(request, id, (run) => run.status === "running", 10_000);
    sous(world, ["pause", id]);
    const run = await waitForRun(request, id, (r) => r.status === "paused" || r.steps.some((s) => s.label === "long step"), 10_000);
    if (run.status === "paused") return id;
    stopRun(world, id);
  }
  throw new Error("no slow run paused during its warm up in three tries");
}

/** The run is gone from the home: its page answers 404. */
async function expectRunGone(request: APIRequestContext, id: string) {
  await expect
    .poll(async () => (await request.get(`/api/runs/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status(), { timeout: 15_000, message: `run ${id} is still there` })
    .toBe(404);
}

test("answer a question, and the run goes on to its end", async ({ page, request }) => {
  const run = greetRun(await theWorld(request));
  await openPage(page, "/runs");

  // The run waits on the person, so its row sits under Needs you.
  await runRow(page, `Needs you ${run.title} greet`).click();
  await expect(page.getByRole("heading", { level: 1, name: run.title })).toBeVisible();
  await expect(headerStatus(page, "Needs you")).toBeVisible();

  const question = page.getByRole("region", { name: "Who should we greet?" });
  await expect(question.getByRole("button", { name: "Answer" })).toBeDisabled();
  await question.getByRole("textbox", { name: "Your answer" }).fill("World");
  await question.getByRole("button", { name: "Answer" }).click();

  await expect(toast(page, "Answer sent")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: 'You answered "World". The run goes on.' })).toBeVisible();
  await expect(main(page).getByText(`sous answer ${run.id}--1 World`)).toBeVisible();

  // The run goes on to the greet step and ends.
  await expect(runRow(page, `Done ${run.title} greet`)).toBeVisible({ timeout: 15_000 });
  await expect(headerStatus(page, "Done")).toBeVisible();
  await expect(fact(main(page), "Finished")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);

  // The greet step greeted the answer.
  await viewSwitch(page).getByRole("radio", { name: "Steps" }).click();
  await page.getByRole("button", { name: /^Done greet\b/ }).click();
  await expect(page.getByRole("region", { name: "Result of greet" })).toContainText(`${run.title}, World`);
});

test("approve a breakpoint, and the run goes on", async ({ page, request }) => {
  const id = startRun(await theWorld(request), "review");
  await openPage(page, `/runs/${id}`);

  const breakpoint = page.getByRole("region", { name: "Approve the release notes" });
  // What the step before the breakpoint made shows for review.
  await expect(breakpoint.getByText("What it shows for review")).toBeVisible();
  await expect(breakpoint.getByText("v1.2: faster start")).toBeVisible();
  await breakpoint.getByRole("button", { name: "Approve" }).click();

  await expect(toast(page, "Approved")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "You approved it. The run goes on." })).toBeVisible();
  // The ship step after the breakpoint runs, and the run ends.
  await expect(page.getByRole("region", { name: `Graph of ${id}` }).getByRole("button", { name: /^ship\b.*, done$/ })).toBeVisible({ timeout: 15_000 });
  await expect(headerStatus(page, "Done")).toBeVisible();
});

test("send a breakpoint back with a note, and its steps run again", async ({ page, request }) => {
  const id = startRun(await theWorld(request), "review");
  await openPage(page, `/runs/${id}`);

  const breakpoint = page.getByRole("region", { name: "Approve the release notes" });
  await expect(page.getByText("1 step done so far")).toBeVisible();
  // The toggle opens a form that has a Send back of its own, so the toggle is the first one.
  const toggle = breakpoint.getByRole("button", { name: "Send back" }).first();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const note = breakpoint.getByRole("textbox", { name: "What should change?" });
  await expect(note).toBeFocused();
  await note.fill("Name the release date");
  // The form's own Send back, under the note.
  await breakpoint.getByRole("button", { name: "Send back" }).last().click();

  await expect(toast(page, "Sent back")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: 'You sent it back with "Name the release date". The steps inside run again.' })).toBeVisible();
  // The draft step runs a second time, and the breakpoint asks again.
  await expect(page.getByText("2 steps done so far")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Approve the release notes" }).getByRole("button", { name: "Approve" })).toBeVisible();
  // Draft is one step that ran twice. Its panel switches between the two calls.
  await viewSwitch(page).getByRole("radio", { name: "Steps" }).click();
  const draft = page.getByRole("region", { name: "Steps" }).getByRole("button", { name: /^Done draft\b/ });
  await expect(draft).toHaveCount(1);
  await draft.click();
  await expect(page.getByRole("region", { name: "Details of draft" }).getByRole("group", { name: "Calls" })).toContainText("Call 2 of 2");

  // Approving the second ask ends the run.
  await page.getByRole("region", { name: "Approve the release notes" }).getByRole("button", { name: "Approve" }).click();
  await expect(headerStatus(page, "Done")).toBeVisible({ timeout: 15_000 });
});

test("stop a running run", async ({ page, request }) => {
  const world = await theWorld(request);
  const id = startRun(world, "slow");
  try {
    await openPage(page, `/runs/${id}`);
    const graph = page.getByRole("region", { name: `Graph of ${id}` });
    await expect(graph.getByRole("button", { name: /^long step\b.*, running$/ })).toBeVisible({ timeout: 15_000 });
    await expect(headerStatus(page, "Running")).toBeVisible();

    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(toast(page, new RegExp(`^(Stopping|Stopped) ${id}$`))).toBeVisible();
    await expect(headerStatus(page, "Stopped")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    // A stopped run does not resume.
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
  } finally {
    stopRun(world, id);
  }
});

test("resume a paused run", async ({ page, request }) => {
  const world = await theWorld(request);
  const id = await pausedSlowRun(world, request);
  try {
    await openPage(page, `/runs/${id}`);
    await expect(headerStatus(page, "Paused")).toBeVisible();
    await expect(main(page).getByText("Paused, as asked. Resume goes on from where it stopped.")).toBeVisible();
    await expect(main(page).getByText(`sous resume ${id}`)).toBeVisible();

    // Resume is the header's one primary while the run is paused.
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(toast(page, `Resumed ${id}`)).toBeVisible();
    // The run goes on from where it paused: the long step after the warm up runs.
    await expect(page.getByRole("region", { name: `Graph of ${id}` }).getByRole("button", { name: /^long step\b.*, running$/ })).toBeVisible({ timeout: 15_000 });
    await expect(headerStatus(page, "Running")).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
  } finally {
    stopRun(world, id);
  }
});

test("pause a run from its More menu, then resume it and answer", async ({ page, request }) => {
  const run = greetRun(await theWorld(request), "Paused");
  await openPage(page, `/runs/${run.id}`);
  await expect(headerStatus(page, "Needs you")).toBeVisible();

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect(toast(page, `Pausing ${run.id}`)).toBeVisible();
  const resume = page.getByRole("button", { name: "Resume" });
  await expect(resume).toBeVisible({ timeout: 15_000 });

  await resume.click();
  await expect(toast(page, `Resumed ${run.id}`)).toBeVisible();
  await expect(resume).toHaveCount(0, { timeout: 15_000 });

  const question = page.getByRole("region", { name: "Who should we greet?" });
  await question.getByRole("textbox", { name: "Your answer" }).fill("Pat");
  await question.getByRole("button", { name: "Answer" }).click();
  await expect(runRow(page, `Done ${run.title} greet`)).toBeVisible({ timeout: 15_000 });
});

// The server answers {running: false}, so the page says the answer waits for a resume.
test("an answer to a paused run does not say the run goes on", async ({ page, request }) => {
  const run = greetRun(await theWorld(request), "Held");
  await openPage(page, `/runs/${run.id}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 15_000 });

  const question = page.getByRole("region", { name: "Who should we greet?" });
  await question.getByRole("textbox", { name: "Your answer" }).fill("Pat");
  await question.getByRole("button", { name: "Answer" }).click();
  const answered = page.getByRole("status").filter({ hasText: 'You answered "Pat".' });
  await expect(answered).toBeVisible();
  await expect(headerStatus(page, "Paused")).toBeVisible({ timeout: 15_000 });
  await expect(answered).not.toContainText("The run goes on.");
  await expect(answered).toContainText("once you resume it");
});

test("start a workflow from the start dialog, and its run shows up without a reload", async ({ page }) => {
  const title = unique("Hey");
  await openPage(page, "/runs");
  await markPage(page);

  await runsList(page).getByRole("button", { name: "Start a workflow" }).click();
  const picker = page.getByRole("dialog", { name: "Start a workflow" });
  await picker.getByRole("combobox", { name: "Start a workflow" }).fill("greet");
  await picker.getByRole("option", { name: /^greet\b/ }).click();

  const form = page.getByRole("dialog", { name: "Start greet" });
  await expect(form.getByText("Ask who to greet, then greet them")).toBeVisible();
  const greeting = form.getByRole("textbox", { name: /^greeting\b/ });
  await expect(greeting).toHaveValue("Hello");
  await greeting.fill(title);
  // The dialog shows the same start as a terminal command.
  await expect(form.getByText(`sous run greet -- --greeting=${title}`)).toBeVisible();
  await form.getByRole("button", { name: "Start", exact: true }).click();

  await expect(toast(page, "Started greet")).toBeVisible();
  await expect(form).toBeHidden();
  // The page opens the new run, and the list holds it under Needs you once it asks.
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(fact(main(page), "Started by")).toHaveText("This page");
  await expect(runRow(page, `Needs you ${title} greet`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Who should we greet?" })).toBeVisible();
  await expectNoReload(page);
});

test("a run started and answered from a terminal shows up live", async ({ page, request }) => {
  const world = await theWorld(request);
  await openPage(page, "/runs");
  await expect(runsList(page).getByRole("heading", { level: 2 }).first()).toBeVisible();
  await markPage(page);

  const run = greetRun(world, "Terminal");
  const row = runRow(page, `Needs you ${run.title} greet`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByRole("heading", { level: 1, name: run.title })).toBeVisible();
  await expect(fact(main(page), "Started by")).toHaveText("Terminal");
  await expect(page.getByRole("region", { name: "Who should we greet?" })).toBeVisible();

  // The answer comes from the terminal too, and the open page follows.
  sous(world, ["answer", run.id, "Moon"]);
  await expect(page.getByRole("region", { name: "Who should we greet?" })).toHaveCount(0, { timeout: 15_000 });
  await expect(runRow(page, `Done ${run.title} greet`)).toBeVisible({ timeout: 15_000 });
  await expect(headerStatus(page, "Done")).toBeVisible();
  await expectNoReload(page);
});

test("group the runs list by status and by project", async ({ page }) => {
  await openPage(page, "/runs");
  const list = runsList(page);
  const headings = list.getByRole("heading", { level: 2 });
  await expect(list.getByRole("heading", { name: /^Needs you \d+$/ })).toBeVisible();
  await expect(list.getByRole("heading", { name: /^Done \d+$/ })).toBeVisible();
  const counts = (texts: string[]) => texts.reduce((sum, text) => sum + Number(/(\d+)$/.exec(text.trim())?.[1] ?? 0), 0);
  const total = counts(await headings.allTextContents());

  await list.getByRole("button", { name: "View options" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio", { name: "Status" })).toBeChecked();
  // A pick closes the menu.
  await menu.getByRole("menuitemradio", { name: "Project" }).click();
  await expect(menu).toBeHidden();

  // One group per project: the world has one, shop, with every run in it.
  await expect(headings).toHaveText([`shop ${total}`]);
  await expect(list.getByRole("heading", { name: /^Needs you/ })).toHaveCount(0);

  // This browser keeps the grouping.
  await page.reload();
  await expect(headings).toHaveText([`shop ${total}`]);

  await list.getByRole("button", { name: "View options" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Project" })).toBeChecked();
  await menu.getByRole("menuitemradio", { name: "Status" }).click();
  await expect(menu).toBeHidden();
  await expect(list.getByRole("heading", { name: /^Needs you \d+$/ })).toBeVisible();
  await expect(list.getByRole("heading", { name: /^shop/ })).toHaveCount(0);
});

test("a run's graph and steps views, and one step opened", async ({ page, request }) => {
  const id = startRun(await theWorld(request), "fanout");
  await waitForRun(request, id, (run) => run.status === "done");
  await openPage(page, `/runs/${id}`);

  const views = viewSwitch(page);
  await expect(views.getByRole("radio", { name: "Graph" })).toBeChecked();
  await expect(page.getByText("6 of 6 steps done")).toBeVisible();
  const graph = page.getByRole("region", { name: `Graph of ${id}` });
  await expect(graph.getByRole("button", { name: /^parts\b.*, done$/ })).toBeVisible();
  // The gate's box names its last round. Its title and round are two spans.
  await expect(graph.getByText(/^gate\s*round 3 of 3$/)).toBeVisible();
  // The graph's steps in order, for a screen reader.
  const order = page.getByRole("list", { name: "The graph's steps, in order" });
  await expect(order).toContainText("check api");
  await expect(order).toContainText("The workflow ends.");

  // A node opens its panel beside the graph. The view stays the graph.
  await graph.getByRole("button", { name: /^summarize\b.*, done$/ }).click();
  await expect(views.getByRole("radio", { name: "Graph" })).toBeChecked();
  const summarize = page.getByRole("region", { name: "Details of summarize" });
  await expect(summarize).toBeVisible();
  await expect(graph).toBeVisible();
  await expect(summarize.getByText("JavaScript step", { exact: true })).toBeVisible();
  await expect(summarize.getByRole("region", { name: "Result of summarize" })).toContainText("summary");
  // It ran once in each round of the gate. The panel shows the latest call, and switches to the others.
  const calls = summarize.getByRole("group", { name: "Calls" });
  await expect(calls).toContainText("Call 3 of 3");
  await calls.getByRole("button", { name: "Earlier call" }).click();
  await expect(calls).toContainText("Call 2 of 3");

  // The Steps view keeps the selected step, and shows summarize once, under its gate.
  await views.getByRole("radio", { name: "Steps" }).click();
  await expect(page.getByRole("region", { name: "Details of summarize" })).toBeVisible();
  const steps = page.getByRole("region", { name: "Steps" });
  // A finished pipeline starts folded, as in the graph.
  await steps.getByRole("button", { name: "Open pipeline over parts" }).click();
  await expect(steps.getByRole("button", { name: /^Done check (api|page|docs)\b/ })).toHaveCount(3);
  const summarizeRow = steps.getByRole("button", { name: /^Done summarize\b/ });
  await expect(summarizeRow).toHaveCount(1);
  await expect(summarizeRow).toHaveAttribute("aria-current", "true");

  // Select another step: its command and output. The panel shows one step at a time.
  const checkApi = steps.getByRole("button", { name: /^Done check api\b/ });
  await checkApi.click();
  await expect(checkApi).toHaveAttribute("aria-current", "true");
  const details = page.getByRole("region", { name: "Details of check api" });
  await expect(details.getByRole("region", { name: "Command of check api" })).toContainText("echo checked api");
  await expect(details.getByRole("region", { name: "Output of check api" })).toContainText("checked api");
  await expect(page.getByRole("region", { name: "Details of summarize" })).toHaveCount(0);

  // A group folds and unfolds at a press. The selected step is outside it, so its panel stays.
  await steps.getByRole("button", { name: "Fold gate" }).click();
  await expect(steps.getByRole("button", { name: "Open gate" })).toHaveAttribute("aria-expanded", "false");
  await expect(summarizeRow).toHaveCount(0);
  await steps.getByRole("button", { name: "Open gate" }).click();
  await expect(steps.getByRole("button", { name: "Fold gate" })).toHaveAttribute("aria-expanded", "true");
  await expect(summarizeRow).toHaveCount(1);
  await expect(details).toBeVisible();

  // The selected step lives in the link, so a reload selects it again.
  await page.reload();
  await expect(page.getByRole("region", { name: "Details of check api" })).toBeVisible();

  // Back on the graph, the step stays selected, and Escape closes its panel.
  await views.getByRole("radio", { name: "Graph" }).click();
  await expect(page.getByRole("region", { name: `Graph of ${id}` })).toBeVisible();
  await expect(page.getByRole("region", { name: "Steps" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Details of check api" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Details of check api" })).toHaveCount(0);
});

// A step selected in the graph opens the groups around it in Steps once. A press on one folds it at once.
test("a group that holds the selected step folds at a press", async ({ page, request }) => {
  const id = startRun(await theWorld(request), "fanout");
  await waitForRun(request, id, (run) => run.status === "done");
  await openPage(page, `/runs/${id}`);
  await page.getByRole("region", { name: `Graph of ${id}` }).getByRole("button", { name: /^summarize\b.*, done$/ }).click();
  await expect(page.getByRole("region", { name: "Details of summarize" })).toBeVisible();
  await viewSwitch(page).getByRole("radio", { name: "Steps" }).click();

  const steps = page.getByRole("region", { name: "Steps" });
  await expect(steps.getByRole("button", { name: /^Done summarize\b/ })).toHaveCount(1);
  await steps.getByRole("button", { name: "Fold gate" }).click();
  await expect(steps.getByRole("button", { name: "Open gate" })).toHaveAttribute("aria-expanded", "false");
  await expect(steps.getByRole("button", { name: /^Done summarize\b/ })).toHaveCount(0);
});

test("an agent step shows its tries, tokens and activity, and a running one takes a message", async ({ page, request }) => {
  const world = await theWorld(request);
  // The fake program fails the first flaky request as overloaded, so the run serve.mjs started
  // took two tries. Later flaky runs take one.
  await openPage(page, "/runs");
  await runRow(page, "Done flaky").click();
  await expect(page.getByRole("heading", { level: 1, name: "flaky" })).toBeVisible();
  await viewSwitch(page).getByRole("radio", { name: "Steps" }).click();
  await page.getByRole("button", { name: /^Done fix test\b/ }).click();

  const fix = page.getByRole("region", { name: "Details of fix test" });
  await expect(fix.getByText(/^Agent step\b/)).toBeVisible();
  // The call's model comes first. The step's settings, lower in the panel, name it too.
  await expect(fact(fix, "Model").first()).toHaveText("codex");
  await expect(fact(fix, "Tries")).toHaveText("2");
  await expect(fact(fix, "Input")).toHaveText("240");
  await expect(fact(fix, "Output")).toHaveText("60");
  await expect(fix.getByText("Fix the flaky login test.")).toBeVisible();
  await expect(fix.getByText("Overloaded")).toBeVisible();
  await expect(fix.getByText("The test waited on a timer. It now waits on the login event.")).toBeVisible();

  // An agent that still works: its tool call, "Working", and a field to tell it something.
  const id = startRun(world, "investigate");
  try {
    await openPage(page, `/runs/${id}?view=steps`);
    await page.getByRole("button", { name: /^Running investigate\b/ }).click({ timeout: 15_000 });
    const investigate = page.getByRole("region", { name: "Details of investigate" });
    await expect(fact(investigate, "Status")).toHaveText("Running");
    await expect(investigate.getByText("Bash", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(investigate.getByText('{"command":"ls"}')).toBeVisible();
    await expect(investigate.getByText("Working", { exact: true })).toBeVisible();

    const tell = investigate.getByRole("textbox", { name: "Tell investigate" });
    await expect(investigate.getByRole("button", { name: "Tell" })).toBeDisabled();
    await tell.fill("Look at the cache too");
    await investigate.getByRole("button", { name: "Tell" }).click();
    await expect(toast(page, /^(Told investigate|Sent to investigate, not read yet)$/)).toBeVisible({ timeout: 15_000 });
    await expect(tell).toHaveValue("");
  } finally {
    stopRun(world, id);
  }
});

test("markdown shows rendered, or raw at a press", async ({ page }) => {
  await openPage(page, "/skills");
  await page.getByRole("complementary", { name: "Skills list" }).getByRole("link", { name: "release-notes" }).click();
  const show = page.getByRole("radiogroup", { name: "Show SKILL.md as" });
  await expect(show.getByRole("radio", { name: "Rendered" })).toBeChecked();
  await expect(main(page).getByRole("heading", { level: 1, name: "Release notes" })).toBeVisible();

  await show.getByRole("radio", { name: "Raw" }).click();
  const raw = page.getByRole("region", { name: "Text of SKILL.md" });
  await expect(raw).toContainText("name: release-notes");
  await expect(raw).toContainText("# Release notes");
  await expect(main(page).getByRole("heading", { name: "Release notes" })).toHaveCount(0);

  await show.getByRole("radio", { name: "Rendered" }).click();
  await expect(main(page).getByRole("heading", { level: 1, name: "Release notes" })).toBeVisible();
  await expect(raw).toHaveCount(0);

  // An agent's prompt has the same switch.
  await openPage(page, "/agents/reviewer");
  const prompt = page.getByRole("region", { name: "Prompt" });
  await expect(prompt.getByText("You review one change.")).toBeVisible();
  await prompt.getByRole("radiogroup", { name: "Show reviewer.md as" }).getByRole("radio", { name: "Raw" }).click();
  await expect(prompt.getByRole("region", { name: "Text of reviewer.md" })).toContainText("tools: Read, Grep, Glob");
});

test("search the runs list, and jump anywhere with the jump menu", async ({ page, request }) => {
  const run = greetRun(await theWorld(request), "Findme");
  await openPage(page, "/runs");
  const list = runsList(page);
  await expect(runRow(page, `Needs you ${run.title} greet`)).toBeVisible({ timeout: 15_000 });

  // "/" goes to the search.
  await page.keyboard.press("/");
  const search = list.getByRole("searchbox", { name: "Search runs" });
  await expect(search).toBeFocused();
  await page.keyboard.type(run.title);
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(runRow(page, `Needs you ${run.title} greet`)).toBeVisible();

  await search.fill("zz-no-such-run");
  await expect(list.getByText('No run matches "zz-no-such-run".')).toBeVisible();
  await list.getByRole("button", { name: "Clear the search" }).filter({ hasText: "Clear the search" }).click();
  await expect(search).toHaveValue("");
  await expect(runRow(page, `Needs you ${run.title} greet`)).toBeVisible();
  expect(await list.getByRole("link").count()).toBeGreaterThan(1);

  // The jump menu finds a run by its id.
  await page.getByRole("heading", { level: 1, name: "Runs" }).click();
  await page.keyboard.press("ControlOrMeta+k");
  const jump = page.getByRole("dialog", { name: "Jump to" });
  await jump.getByRole("combobox", { name: "Jump to" }).fill(run.id);
  await jump.getByRole("option", { name: new RegExp(`^${run.title}\\b`) }).click();
  await expect(jump).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: run.title })).toBeVisible();

  // And a skill by its name.
  await page.keyboard.press("ControlOrMeta+k");
  await jump.getByRole("combobox", { name: "Jump to" }).fill("release-notes");
  await jump.getByRole("option", { name: /^release-notes\b/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "release-notes" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Skills" })).toBeVisible();
});

test("move a workflow to the trash from its page", async ({ page, request }) => {
  const world = await theWorld(request);
  const name = unique("scratch");
  const file = join(world.project, ".sous", "workflows", `${name}.js`);
  await openPage(page, "/workflows");
  const list = page.getByRole("complementary", { name: "Workflows list" });
  await expect(list.getByRole("link", { name: "greet", exact: true })).toBeVisible();

  // A new file shows up in the list as it lands, marked as changed since the last yes.
  writeFileSync(
    file,
    `export const meta = {\n  name: "${name}",\n  description: "A workflow the trash check moves away",\n  place: "none",\n}\n\nawait sh("echo hi", { label: "hi" })\n`,
  );
  await list.getByRole("link", { name: `${name} changed`, exact: true }).click({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  await main(page).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  const confirm = page.getByRole("alertdialog", { name: `Move ${name}.js to the trash?` });
  await expect(confirm.getByText(file)).toBeVisible();
  await confirm.getByRole("button", { name: "Move to trash" }).click();

  await expect(toast(page, `Moved ${name}.js to the trash`)).toBeVisible();
  await expect(confirm).toBeHidden();
  await expect(page).toHaveURL(/#\/workflows$/);
  await expect(list.getByRole("link", { name: new RegExp(`^${name}\\b`) })).toHaveCount(0);
  expect(existsSync(file)).toBe(false);
});

test("remove a run that ended, from its row with an undo, and from its page", async ({ page, request }) => {
  const world = await theWorld(request);
  const run = greetRun(world, "Gone");
  await waitForRun(request, run.id, (r) => r.questions.length > 0);
  sous(world, ["answer", run.id, "Pat"]);
  const fanout = startRun(world, "fanout");
  await waitForRun(request, run.id, (r) => r.status === "done");
  await waitForRun(request, fanout, (r) => r.status === "done");

  await openPage(page, "/runs");
  const row = runRow(page, `Done ${run.title} greet`);
  const remove = runsList(page).getByRole("button", { name: `Remove ${run.title}` });
  await row.hover();
  await remove.click();
  await expect(row).toHaveCount(0);
  // Undo brings the row back, and nothing goes to the server.
  await toast(page, `Removed ${run.title}`).getByRole("button", { name: "Undo" }).click();
  await expect(row).toBeVisible();

  await row.hover();
  await remove.click();
  await expect(row).toHaveCount(0);
  // The delete goes out once Undo had its 8 seconds.
  await expectRunGone(request, run.id);
  await page.reload();
  await expect(runsList(page).getByRole("heading", { level: 2 }).first()).toBeVisible();
  await expect(row).toHaveCount(0);

  // From the run's own page, after a question that names it.
  await openPage(page, `/runs/${fanout}`);
  await expect(headerStatus(page, "Done")).toBeVisible();
  await main(page).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const confirm = page.getByRole("alertdialog", { name: `Remove ${fanout}?` });
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(toast(page, `Removed ${fanout}`)).toBeVisible();
  await expect(page).toHaveURL(/#\/runs$/);
  await expectRunGone(request, fanout);
  const rows = await api<RunRow[]>(request, "runs");
  expect(rows.some((r) => r.id === fanout || r.id === run.id)).toBe(false);
  await page.goto(`/#/runs/${fanout}`);
  await expect(page.getByRole("heading", { level: 1, name: "Run not found" })).toBeVisible();
});

test.describe("the theme", () => {
  test.use({ colorScheme: "light" });

  const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  test("switches between light and dark, and sticks after a reload", async ({ page }) => {
    await openPage(page, "/settings");
    const theme = page.getByRole("radiogroup", { name: "Theme" });
    await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
    const light = await background(page);

    await theme.getByRole("radio", { name: "Dark" }).click();
    await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Theme: dark" })).toBeVisible();
    await expect.poll(() => background(page)).not.toBe(light);
    const dark = await background(page);

    await page.reload();
    await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect.poll(() => background(page)).toBe(dark);

    await theme.getByRole("radio", { name: "Light" }).click();
    await expect.poll(() => background(page)).toBe(light);
    await page.reload();
    await expect(theme.getByRole("radio", { name: "Light" })).toBeChecked();

    // The rail's theme button goes light, dark, system.
    await page.getByRole("button", { name: "Theme: light" }).click();
    await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect.poll(() => background(page)).toBe(dark);
    await page.getByRole("button", { name: "Theme: dark" }).click();
    await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
    await expect.poll(() => background(page)).toBe(light);
  });
});
