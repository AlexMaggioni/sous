// What a step does, entry by entry. The steps module reports an agent step's prompt and what its
// program did, and the code steps report their command and output. The worker saves each entry
// to the run's activity file, and `sous step` reads them back.

/** The step an entry belongs to: the run or nested run it runs in, its call and its label. */
export interface ActivityStep {
  scope: string;
  callIndex: number;
  label?: string;
}

/** One thing a step did. A tool entry names the tool. A tell's receipt has the tell's id. */
export interface ActivityEntry {
  kind: "prompt" | "text" | "tool" | "tool-result" | "command" | "output" | "tell" | "note" | "error";
  tool?: string;
  text: string;
  id?: string;
}

export type OnActivity = (step: ActivityStep, entry: ActivityEntry) => void;

/** The step of a call, when the call names its run and its index. */
export function activityStep(scope: string | undefined, callIndex: number | undefined, label: string | undefined): ActivityStep | undefined {
  if (scope === undefined || callIndex === undefined) return undefined;
  return { scope, callIndex, ...(label === undefined ? {} : { label }) };
}
