// Reading a schema step's answer, and checking a step's images before it runs. These moved
// here from acp-agents' structured-output and runner-images tests, with the code they test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { isWorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { checkImages, extractValidated, findJsonBlock, validateValue } from "../src/steps/answer.js";

const SCHEMA = Type.Object({ city: Type.String(), hot: Type.Boolean() });

describe("a schema answer", () => {
  it("findJsonBlock prefers a fenced json block", () => {
    assert.equal(findJsonBlock('prose\n```json\n{"a":1}\n```\nmore'), '{"a":1}');
    assert.equal(findJsonBlock("```\n[1,2,3]\n```"), "[1,2,3]");
  });

  it("findJsonBlock falls back to the first balanced object or array", () => {
    assert.equal(findJsonBlock('here {"a":{"b":2}} tail'), '{"a":{"b":2}}');
    assert.equal(findJsonBlock("x [1,[2],3] y"), "[1,[2],3]");
    assert.equal(findJsonBlock("no json here"), undefined);
  });

  it("validateValue converts toward the schema, then checks", () => {
    assert.deepEqual(validateValue({ city: "NYC", hot: "true" }, SCHEMA), { city: "NYC", hot: true });
    // A wrong shape gives nothing. It never makes a value up.
    assert.equal(validateValue({ city: "NYC" }, SCHEMA), undefined);
    assert.equal(validateValue("not an object", SCHEMA), undefined);
  });

  it("extractValidated takes JSON from prose only when it fits", () => {
    assert.deepEqual(extractValidated('Result:\n```json\n{"city":"LA","hot":false}\n```', SCHEMA), { city: "LA", hot: false });
    assert.equal(extractValidated('{"city":"LA"}', SCHEMA), undefined);
    assert.equal(extractValidated("totally freeform text", SCHEMA), undefined);
  });
});

describe("a step's images", () => {
  const refused = (images: unknown, label: string | undefined, pattern: RegExp) =>
    assert.throws(
      () => checkImages(images as never, label),
      (error: unknown) => {
        assert.ok(isWorkflowError(error));
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(error.recoverable, false);
        assert.equal(error.agentLabel, label);
        assert.match(error.message, pattern);
        return true;
      },
    );

  it("refuses a missing data string and names the bad index", () => {
    refused([{ data: "", mimeType: "image/png" }], "image-agent", /images\[0\]\.data/);
  });

  it("refuses a missing mimeType string and names the bad index", () => {
    refused([{ data: "ZmFrZQ==", mimeType: "image/png" }, { data: "ZmFrZQ==", mimeType: " " }], undefined, /images\[1\]\.mimeType/);
  });

  it("refuses a blank uri and names the bad index", () => {
    refused([{ data: "ZmFrZQ==", mimeType: "image/png" }, { data: "ZmFrZQ==", mimeType: "image/png", uri: "" }], "image-agent", /images\[1\]\.uri/);
  });

  it("passes good images on as mimeType and data", () => {
    assert.deepEqual(checkImages([{ data: "ZmFrZQ==", mimeType: "image/png", uri: "file:///a.png" }]), [{ mimeType: "image/png", data: "ZmFrZQ==" }]);
    assert.deepEqual(checkImages(undefined), []);
  });
});
