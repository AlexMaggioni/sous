// A macOS notice when a run asks something, pauses or ends, and when an agent decides for the
// person. Off with "notify": false in config.json or SOUS_NOTIFY=0. Elsewhere it does nothing.

import { spawn } from "node:child_process";
import { noticeOf, recordAction, type Action } from "./actions.js";
import { loadConfig, type HomePaths } from "./home.js";

export function notify(title: string, message: string, enabled = true): void {
  if (!enabled || process.env.SOUS_NOTIFY === "0" || process.platform !== "darwin") return;
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

/** How a notice reaches the person: a title and a message. */
export type Tell = (title: string, message: string) => void;

/** Add the action as recordAction does, and send the person its notice when it has one. `tell`
 *  sends it, a macOS notice by default, off when config.json says "notify": false. */
export function recordAndTell(paths: HomePaths, action: Omit<Action, "at">, tell?: Tell): Action {
  const line = recordAction(paths, action);
  const notice = noticeOf(line);
  if (notice) (tell ?? ((title, message) => notify(title, message, loadConfig(paths).notify)))(notice.title, notice.message);
  return line;
}
