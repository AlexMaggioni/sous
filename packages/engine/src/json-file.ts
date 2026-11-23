/**
 * Write a JSON file so a reader never sees half of it. The value goes to a temporary file next to
 * the target, then a rename replaces the target. The temporary name carries the process id, so
 * two processes writing the same file never share one.
 */

import { chmodSync, renameSync, writeFileSync } from "node:fs";

/** Write `value` as indented JSON with a final newline. `mode` sets the file's permissions. */
export function writeJsonFile(file: string, value: unknown, mode?: number): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode });
  // writeFileSync applies the mode only when it creates the file, and the umask can narrow it.
  if (mode !== undefined) chmodSync(temp, mode);
  renameSync(temp, file);
}
