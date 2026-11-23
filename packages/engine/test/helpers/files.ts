// Writing files a test plants.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write `content` to `file`, making the folders above it. */
export function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
