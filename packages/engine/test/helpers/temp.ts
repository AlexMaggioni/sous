// Folders in the temp folder, removed when the test ends.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFakeHomeAsync } from "./fake-home.js";

export interface TempDirs {
  /** A manager's working folder. */
  cwd: string;
  /** The folder its persistence uses. */
  root: string;
  cleanup: () => void;
}

/** A working folder and a persistence folder side by side, in a folder of their own. */
export function tempDirs(prefix = "orc-test"): TempDirs {
  const base = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const cwd = join(base, "cwd");
  const root = join(base, "root");
  mkdirSync(cwd);
  mkdirSync(root);
  return { cwd, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Run `run` with a working folder and a persistence folder, and remove them after. */
export async function withTempDirs<T>(run: (dirs: TempDirs) => Promise<T>, prefix?: string): Promise<T> {
  const dirs = tempDirs(prefix);
  try {
    return await run(dirs);
  } finally {
    dirs.cleanup();
  }
}

/**
 * A test body that gets a working folder of its own and a fake home, so run state reaches no
 * real folder. Both go when the body ends. Pass the result to `test()`.
 */
export function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-test-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "orc-test-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}
