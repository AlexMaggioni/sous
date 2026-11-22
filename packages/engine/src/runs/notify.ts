// A macOS notice when a run asks something, pauses or ends. Off with "notify": false in
// config.json or ORC_NOTIFY=0. Elsewhere it does nothing.

import { spawn } from "node:child_process";

export function notify(title: string, message: string, enabled = true): void {
  if (!enabled || process.env.ORC_NOTIFY === "0" || process.platform !== "darwin") return;
  const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 240)}"`;
  try {
    const child = spawn("osascript", ["-e", `display notification ${quote(message)} with title ${quote(title)}`], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // a notice is never worth failing a run
  }
}
