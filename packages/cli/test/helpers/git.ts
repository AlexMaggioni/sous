// Git in a test's folders.

import { execFileSync } from "node:child_process";

/** Run git in `cwd` and give what it prints, trimmed. It throws when git fails. */
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
