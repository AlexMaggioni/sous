import type { Harness } from "../../api/contract.ts";
import { HARNESS_NAME } from "../../lists/catalog-rows.ts";

/** Where a file sits, such as "Project rulesync" or "Home Claude Code". */
export const placeOf = (scope: "project" | "global", from: Harness | "rulesync") => `${scope === "project" ? "Project" : "Home"} ${from === "rulesync" ? "rulesync" : HARNESS_NAME[from]}`;
