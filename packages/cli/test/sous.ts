// Run sous's main in this process, on a test's home, and keep what it prints.

import assert from "node:assert/strict";
import type { HomePaths } from "@sous/engine";
import { main, type MainOptions } from "../src/cli.js";

/**
 * Keep what sous writes to stdout and stderr. The test runner reports through stdout in bytes,
 * and a wait in a terminal lasts long enough to meet its writes, so bytes pass through.
 */
export function capture(printed: string[]): () => void {
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const keep = (original: typeof write) =>
    ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === "string" ? (printed.push(chunk), true) : (original as (...args: unknown[]) => boolean)(chunk, ...rest))) as typeof write;
  process.stdout.write = keep(write);
  process.stderr.write = keep(writeErr);
  return () => {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  };
}

/** Run sous on this home and keep what it prints, to stdout and stderr. A test that starts or
 *  resumes a run passes its launcher in `options`. */
export async function sous(paths: HomePaths, argv: string[], options: MainOptions = {}): Promise<{ code: number; out: string }> {
  const before = process.env.SOUS_HOME;
  process.env.SOUS_HOME = paths.home;
  const printed: string[] = [];
  const restore = capture(printed);
  try {
    return { code: await main(argv, options), out: printed.join("") };
  } finally {
    restore();
    if (before === undefined) delete process.env.SOUS_HOME;
    else process.env.SOUS_HOME = before;
  }
}

/** Poll until `ready` holds, and fail after 20 seconds, which a slow machine does not reach. */
export async function waitFor(ready: () => boolean, what = "the condition"): Promise<void> {
  for (let i = 0; i < 2000 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ready(), `timed out waiting for ${what}`);
}
