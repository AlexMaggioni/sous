// The record of a thrown value in a run's call manifest. Any part the projection could not take
// sets `lossy`, and a record with it is not a baseline to compare a later run with.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { projectRecordedError } from "../src/recorded-error.js";

const workflowError = () => new WorkflowError("it broke", WorkflowErrorCode.SCRIPT_ERROR, { recoverable: true, agentLabel: "build", details: { at: 3 }, resetHint: "in 5 minutes" });

const throwing = (): never => {
  throw new Error("getter");
};

/** The error with one own field replaced, so a read of it gives `get` or `value`. */
function withField<T extends Error>(error: T, key: string, field: { value: unknown } | { get: () => unknown }): T {
  Object.defineProperty(error, key, { ...field, enumerable: true, configurable: true });
  return error;
}

describe("the record of a WorkflowError", () => {
  it("keeps every field, and has no lossy flag when each one was taken", () => {
    assert.deepEqual(projectRecordedError(workflowError()), {
      form: "workflow-error",
      message: "it broke",
      code: WorkflowErrorCode.SCRIPT_ERROR,
      recoverable: true,
      agentLabel: "build",
      details: { at: 3 },
      resetHint: "in 5 minutes",
    });
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(projectRecordedError(workflowError())));
  });

  const lossy: Array<[string, () => Error]> = [
    ["a message that is not text", () => withField(workflowError(), "message", { value: 7 })],
    ["a message that cannot be read", () => withField(workflowError(), "message", { get: throwing })],
    ["a code that is not text", () => withField(workflowError(), "code", { value: 42 })],
    ["a code that cannot be read", () => withField(workflowError(), "code", { get: throwing })],
    ["a recoverable flag that is not a boolean", () => withField(workflowError(), "recoverable", { value: "yes" })],
    ["a recoverable flag that cannot be read", () => withField(workflowError(), "recoverable", { get: throwing })],
    ["details that cannot be read", () => withField(workflowError(), "details", { get: throwing })],
    ["details that are not JSON", () => withField(workflowError(), "details", { value: () => 1 })],
    ["an agent label that is not JSON", () => withField(workflowError(), "agentLabel", { value: Symbol("label") })],
  ];
  for (const [title, make] of lossy) {
    it(`is marked lossy for ${title}`, () => {
      assert.equal(projectRecordedError(make()).lossy, true);
    });
  }

  it("keeps the fields it could take when one cannot be read", () => {
    const record = projectRecordedError(withField(workflowError(), "code", { get: throwing }));
    assert.equal(record.message, "it broke");
    assert.equal(record.recoverable, true);
    assert.equal(record.code, undefined);
  });
});

describe("the record of another Error", () => {
  const plain = () => Object.assign(new TypeError("bad route"), { route: "west" });

  it("keeps the name, the message and the own data properties, with no lossy flag", () => {
    assert.deepEqual(projectRecordedError(plain()), { form: "error", name: "TypeError", message: "bad route", props: { route: "west" } });
  });

  it("leaves out props when it has none", () => {
    assert.deepEqual(projectRecordedError(new Error("plain")), { form: "error", name: "Error", message: "plain" });
  });

  const lossy: Array<[string, () => Error]> = [
    ["a name that cannot be read", () => withField(plain(), "name", { get: throwing })],
    ["a message that is not text", () => withField(plain(), "message", { value: 7 })],
    ["a message that cannot be read", () => withField(plain(), "message", { get: throwing })],
    ["a symbol property", () => Object.assign(plain(), { [Symbol("tag")]: 1 })],
    ["a property that is a getter", () => withField(plain(), "route", { get: () => "west" })],
    ["a property that is not JSON", () => withField(plain(), "route", { value: () => "west" })],
  ];
  for (const [title, make] of lossy) {
    it(`is marked lossy for ${title}`, () => {
      assert.equal(projectRecordedError(make()).lossy, true);
    });
  }

  it("does not record a property that is not enumerable, and does not call that lossy", () => {
    const error = plain();
    Object.defineProperty(error, "hidden", { value: 1, enumerable: false });
    assert.deepEqual(projectRecordedError(error).props, { route: "west" });
    assert.equal(projectRecordedError(error).lossy, undefined);
  });
});

describe("the record of a value that is not an Error", () => {
  it("keeps a JSON value", () => {
    assert.deepEqual(projectRecordedError({ reason: "no" }), { form: "value", value: { reason: "no" } });
    assert.deepEqual(projectRecordedError("stop"), { form: "value", value: "stop" });
  });

  it("is lossy, with no value, when the value is not JSON", () => {
    assert.deepEqual(projectRecordedError({ run: () => 1 }), { form: "value", lossy: true });
  });
});
