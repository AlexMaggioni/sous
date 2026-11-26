import { describe, expect, test } from "vitest";
import { SousError, retryOnce } from "../src/api/client.ts";

const refusal = (status: number) => new SousError({ code: "no_such_run", message: "No run r1.", change: "Pick a run from the list.", call: null }, status);

describe("a read that failed", () => {
  test("tries once more when the server could not answer", () => {
    expect(retryOnce(0, new Error("network down"))).toBe(true);
    expect(retryOnce(0, refusal(500))).toBe(true);
    expect(retryOnce(1, refusal(500))).toBe(false);
  });

  test("shows a refusal at once, such as a run that is not there", () => {
    expect(retryOnce(0, refusal(404))).toBe(false);
    expect(retryOnce(0, refusal(400))).toBe(false);
  });
});
