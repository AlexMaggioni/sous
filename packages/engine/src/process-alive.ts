// Whether a process that a file names still runs. A pid alone is not enough after a reboot: the
// new boot gives the same numbers to other processes, and a pid saved before a power cut can name
// one of them. So each file that keeps a pid keeps this boot's id with it, and a pid saved in
// another boot is gone, whatever runs under that number now.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let cached: string | null | undefined;

/** This boot's id. Linux and macOS give one. Undefined elsewhere, and then the pid alone decides. */
export function bootId(): string | undefined {
  if (cached === undefined) cached = readBootId() ?? null;
  return cached ?? undefined;
}

function readBootId(): string | undefined {
  try {
    if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
    if (process.platform === "darwin") {
      const out = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
      return out.trim() || undefined;
    }
  } catch {
    // The system gave no id. The pid check alone decides.
  }
  return undefined;
}

/** True when the process runs. A pid saved with another boot's id is false. A pid saved with no
 *  boot id, as an older sous saved it, gets the pid check alone. */
export function processAlive(pid: number | undefined, boot?: string): boolean {
  if (!Number.isInteger(pid) || pid! <= 0) return false;
  if (boot !== undefined) {
    const now = bootId();
    if (now !== undefined && now !== boot) return false;
  }
  try {
    process.kill(pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
