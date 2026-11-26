// What the checks share: the world serve.mjs made, the sous command as a person types it in a
// terminal of that world, the API reads a check waits on, and the page opened with the token.
// The checks themselves drive the page by role and name.

import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Overview, RunPage } from "../src/api/contract.ts";
import { TOKEN } from "../playwright.config.ts";
import { personEnv, worldAt, type World } from "./world.mjs";

const CLI = fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url));

/** One GET of the API, with the token as a Bearer header, as the Vite dev server sends it. */
export async function api<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api/${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!response.ok()) throw new Error(`GET /api/${path} answered ${response.status()}`);
  return (await response.json()) as T;
}

let known: World | undefined;

/** The world the server runs in. The server names its project folder, and the world's other
 *  folders sit beside it. */
export async function theWorld(request: APIRequestContext): Promise<World> {
  known ??= worldAt(dirname((await api<Overview>(request, "overview")).project.dir));
  return known;
}

/** One sous command, as the person types it in a terminal of the project, with its JSON reply. */
export function sous(world: World, args: string[]): Record<string, unknown> {
  const done = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: world.project, env: personEnv(world), encoding: "utf8" });
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(done.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`sous ${args.join(" ")} printed no JSON: ${(done.stderr || done.stdout).trim()}`);
  }
  const error = reply.error as { message?: string } | undefined;
  if (error) throw new Error(`sous ${args.join(" ")}: ${error.message}`);
  return reply;
}

/** Start a workflow from the terminal, with its inputs as --name=value. Returns the run's id. */
export function startRun(world: World, workflow: string, inputs: Record<string, string> = {}): string {
  const reply = sous(world, ["run", workflow, ...Object.entries(inputs).map(([name, value]) => `--${name}=${value}`)]);
  if (typeof reply.runId !== "string") throw new Error(`sous run ${workflow} gave no run id`);
  return reply.runId;
}

/** Stop a run from the terminal, when a check is done with it. A run that ended already is fine. */
export function stopRun(world: World, runId: string): void {
  try {
    sous(world, ["stop", runId]);
  } catch {
    // It ended on its own.
  }
}

/** Wait until the run, as the API reads it, passes `ready`. */
export async function waitForRun(request: APIRequestContext, runId: string, ready: (run: RunPage) => boolean, timeout = 20_000): Promise<RunPage> {
  let last: RunPage | undefined;
  await expect
    .poll(
      async () => {
        last = await api<RunPage>(request, `runs/${runId}`);
        return ready(last);
      },
      { timeout, message: `run ${runId} did not get there` },
    )
    .toBe(true);
  return last!;
}

/** A word no other run or workflow has, such as "Howdy-m1x2k3", for a check's own run. */
export function unique(word: string): string {
  return `${word}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** Open the page at a hash route, through the link with the token, as sous serve prints it. */
export async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(`/?t=${TOKEN}#${path}`);
}

/** Mark the loaded page, so a check can tell later that it never reloaded. */
export async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { e2eMark?: boolean }).e2eMark = true;
  });
}

/** The page still holds the mark, so it did not reload. */
export async function expectNoReload(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { e2eMark?: boolean }).e2eMark), "the page reloaded").toBe(true);
}

export const runsList = (page: Page): Locator => page.getByRole("complementary", { name: "Runs list" });

/** The run's row in the list column. Its name is the status, the title and the workflow when it differs. */
export const runRow = (page: Page, name: string | RegExp): Locator => runsList(page).getByRole("link", { name });

/** The value under a label in a block of facts, such as Tries in a step's details. */
export const fact = (scope: Locator, label: string): Locator => scope.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");

/** The toast that says what a press did, by its title. */
export const toast = (page: Page, title: string | RegExp): Locator => page.getByRole("region", { name: "Notifications" }).getByRole("listitem", { name: title });
