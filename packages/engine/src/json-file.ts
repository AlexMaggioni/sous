/**
 * Read and write the JSON files under the sous home. A write never lets a reader see half of a
 * file. The value goes to a temporary file next to the target, then a rename replaces the target.
 * The temporary name carries the process id, so two processes writing the same file never share
 * one. A JSON lines file only grows, a line at a time, and its reader skips a torn last line.
 */

import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** A JSON file's value, or undefined when the file is missing or does not parse. */
export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * A JSON file that a person may edit, such as the config or the accounts. A missing file gives
 * `fallback`. A file that does not parse throws with its path, so a mistake in it stops sous
 * instead of passing for an empty file.
 */
export function readStrictJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Write `value` as indented JSON with a final newline. `mode` sets the file's permissions. */
export function writeJsonFile(file: string, value: unknown, mode?: number): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode });
  // writeFileSync applies the mode only when it creates the file, and the umask can narrow it.
  if (mode !== undefined) chmodSync(temp, mode);
  renameSync(temp, file);
}

/** Append `value` to a JSON lines file as one line. The file is made when missing. */
export function appendJsonLine(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** The values of a JSON lines file, in order. A missing file gives none. A line that does not
 *  parse is skipped, such as the torn last line a crash in the middle of a write leaves. */
export function readJsonLines<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const values: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      // a torn line
    }
  }
  return values;
}
