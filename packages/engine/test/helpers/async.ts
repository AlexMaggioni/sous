// Waiting in tests: a promise a test settles by hand, and a wait for a condition.

import assert from "node:assert/strict";

/** A promise the test settles from outside, with `resolve` or `reject`. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Poll every 5 ms until `ready` holds. Fails the test with `message` after `timeoutMs`, which a
 *  slow machine does not reach. */
export async function waitUntil(ready: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > end) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
