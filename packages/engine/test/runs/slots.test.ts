import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bootId } from "../../src/process-alive.js";
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

  it("free a slot and a ticket held in an earlier boot, though their pid names a live process now", async () => {
    const dir = temp("slots-boot");
    const pool = new SlotPool(join(dir, "slots"), join(dir, "queue"), () => 1, "user", 20);
    // This process stands in for the one the new boot gave the old holder's pid.
    const before = { pid: process.pid, boot: "00000000-0000-0000-0000-000000000000" };
    writeFileSync(join(dir, "slots", "slot-0.json"), JSON.stringify({ ...before, since: "2026-11-21T03:00:00.000Z" }));
    writeFileSync(join(dir, "queue", "0-000000000000001-00000001-000001.json"), JSON.stringify(before));
    assert.deepEqual(pool.held(), []);
    assert.deepEqual(pool.waiting(), []);

    writeFileSync(join(dir, "slots", "slot-0.json"), JSON.stringify({ pid: process.pid, boot: bootId() }));
    assert.deepEqual(pool.held(), ["slot-0.json"], "a slot of this boot stays held");
  });
});
