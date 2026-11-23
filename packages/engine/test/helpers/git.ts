// A git repository for tests of worktrees and of runs that note the repository's state.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Run git in `cwd` and give what it prints, trimmed. It throws when git fails. */
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Make `dir` a repository on branch main with one commit, in which `file` holds `content`. It
 * returns `dir`. The commit has its own author, so it needs no git config.
 */
export function initGitRepo(dir: string, file = "file.txt", content = "base\n"): string {
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}
