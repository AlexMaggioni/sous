// What a run's or a step's status says about time, the same on every page.
import type { Status } from "./api/contract.ts";

/** It ended: done, failed or stopped. A paused run may still resume, so it has not. */
export const isEnded = (status: Status): boolean => status === "done" || status === "failed" || status === "stopped";

/** It goes on: it runs or waits on the person. Its durations and bars then tick. */
export const isLive = (status: Status): boolean => status === "running" || status === "needs";
