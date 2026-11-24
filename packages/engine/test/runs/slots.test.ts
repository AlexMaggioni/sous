import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SlotPool } from "../../src/runs/slots.js";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `sous-${name}-`));

describe("agent slots", () => {
  it("cap the agents running at once, and a person's run goes before a scheduled one", async () => {
    const dir = temp("slots");
    const user = new SlotPool(join(dir, "slots"), join(dir, "queue"), () => 1, "user", 20);
    const schedule = new SlotPool(join(dir, "slots"), join(dir, "queue"), () => 1, "schedule", 20);
    const first = await user.acquire({ label: "first" });
    const order: string[] = [];
    const scheduled = schedule.acquire({ label: "scheduled" }).then((release) => { order.push("scheduled"); release(); });
    await new Promise((r) => setTimeout(r, 60));
    const person = user.acquire({ label: "person" }).then((release) => { order.push("person"); release(); });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(order, [], "both wait while the one slot is taken");
    first();
    await Promise.all([scheduled, person]);
    assert.deepEqual(order, ["person", "scheduled"]);
  });
});
