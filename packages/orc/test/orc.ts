// Run orc's main in this process, on a test's home, and keep what it prints.

import type { HomePaths } from "@orchestrator/engine";
import { main, type MainOptions } from "../src/cli.js";

/**
 * Keep what orc writes to stdout and stderr. The test runner reports through stdout in bytes,
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

/** Run orc on this home and keep what it prints, to stdout and stderr. A test that starts or
 *  resumes a run passes its launcher in `options`. */
export async function orc(paths: HomePaths, argv: string[], options: MainOptions = {}): Promise<{ code: number; out: string }> {
  const before = process.env.ORC_HOME;
  process.env.ORC_HOME = paths.home;
  const printed: string[] = [];
  const restore = capture(printed);
  try {
    return { code: await main(argv, options), out: printed.join("") };
  } finally {
    restore();
    if (before === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = before;
  }
}
