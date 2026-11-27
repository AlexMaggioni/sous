// Places for tests whose steps or nested runs get worktrees, built the way the worker builds them.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlaces, type RunPlaces } from "../../src/places/places.js";
import { ensureHome, homePaths, type HomePaths } from "../../src/runs/home.js";
import { placeNotes } from "../../src/runs/records.js";

/** The places of the run tree of `rootRunId` under this home, noted on that run's record. */
export function placesIn(home: HomePaths, rootRunId: string): RunPlaces {
  return runPlaces(home, placeNotes(home, rootRunId));
}

/** A temp home, the places of any run tree under it, and a cleanup that removes the home. */
export function tempPlaces(): { home: HomePaths; places: (rootRunId: string) => RunPlaces; cleanup: () => void } {
  const home = ensureHome(homePaths(mkdtempSync(join(tmpdir(), "sous-test-home-"))));
  return {
    home,
    places: (rootRunId) => placesIn(home, rootRunId),
    cleanup: () => rmSync(home.home, { recursive: true, force: true }),
  };
}

/** The name of one agent() step's worktree and branch: `<run>-<label>-<hash>-<n>`, where the hash
 *  is six characters of the run, the label and the prompt, and n counts the calls with both. */
export function stepTree(runId: string, label: string, prompt: string, occurrence = 1): string {
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(`${runId}\n${label}\n${prompt}`).digest("hex").slice(0, 6);
  return `${slug(runId)}-${slug(label).slice(0, 32) || "agent"}-${hash}-${occurrence}`;
}
