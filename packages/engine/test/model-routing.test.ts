import assert from "node:assert/strict";
import test from "node:test";
import { type ModelRoutingConfig, parseModelRoutingFromMeta, resolveModelForPhase } from "../src/model-routing.js";

const routing = (...routes: Array<[phasePattern: string, model: string]>): ModelRoutingConfig => ({
  defaultModel: "default-model",
  routes: routes.map(([phasePattern, model]) => ({ phasePattern, model })),
});
const RESEARCH = routing(["Research", "explorer-model"]);
const REGEX = routing(["phase-\\d+", "literal-model"]);

/** One row per call of resolveModelForPhase: the case, the routing, the phase and the model it gives. */
const RESOLVE: Array<[name: string, config: ModelRoutingConfig, phase: string | undefined, expected: string | undefined]> = [
  ["returns default when no phases match", routing(), "Discovery", "default-model"],
  ["returns undefined when no default and no routes", { routes: [] }, "Discovery", undefined],
  // A route is present, so a phase of undefined cannot pass for an empty list of routes.
  ["returns defaultModel when phase is undefined", RESEARCH, undefined, "default-model"],
  ["matches a phase title EXACTLY (no fuzzy substring)", RESEARCH, "Research", "explorer-model"],
  ["does not match a title that only contains the route's", RESEARCH, "Deep Research", "default-model"],
  ["matches case-sensitively", RESEARCH, "research", "default-model"],
  ["uses the first matching route", routing(["Scan", "scan-model"], ["Scan", "other-model"]), "Scan", "scan-model"],
  ["treats regex-looking phase patterns as exact literals, so one does not match as a regex", REGEX, "phase-3", "default-model"],
  ["treats regex-looking phase patterns as exact literals, so one matches its own text", REGEX, "phase-\\d+", "literal-model"],
];

for (const [name, config, phase, expected] of RESOLVE) {
  test(`resolveModelForPhase ${name}`, () => assert.equal(resolveModelForPhase(phase, config), expected));
}

/** One row per call of parseModelRoutingFromMeta: the case, the meta's phases and model, and the routing it gives. */
const PARSE: Array<[name: string, phases: Array<{ title: string; model?: string }> | undefined, model: string | undefined, expected: ModelRoutingConfig]> = [
  [
    "extracts routes from phases",
    [{ title: "Scan", model: "fast-model" }, { title: "Analyze" }, { title: "Report", model: "slow-model" }],
    undefined,
    { defaultModel: undefined, routes: [{ phasePattern: "Scan", model: "fast-model" }, { phasePattern: "Report", model: "slow-model" }] },
  ],
  ["carries meta.model as the default", [{ title: "Scan", model: "fast" }], "meta-default", { defaultModel: "meta-default", routes: [{ phasePattern: "Scan", model: "fast" }] }],
  ["returns empty routes / no default when nothing declared", undefined, undefined, { defaultModel: undefined, routes: [] }],
];

for (const [name, phases, model, expected] of PARSE) {
  test(`parseModelRoutingFromMeta ${name}`, () => assert.deepEqual(parseModelRoutingFromMeta(phases, model), expected));
}
