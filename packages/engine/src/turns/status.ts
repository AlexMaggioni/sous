// What a turn's status is. A turn that runs until "done" answers with one flat object, through the
// program's native schema. The object's field descriptions carry the contract, since no prompt or
// system text does. Nothing here does I/O.

export { REPORT_PROMPT } from "../steps/answer.js";

/** The turn sous sends after "working", and after the person leaves a session they stepped into. */
export const CONTINUE_PROMPT = "Continue the task.";

/** What a turn says of its task. */
export type TurnStatusName = "done" | "working" | "question";

/** A turn's answer, read. */
export interface TurnStatus {
  status: TurnStatusName;
  /** The answer when the status is "done". The steps module checks it against the step's schema. */
  result: unknown;
  /** What is left, or the question for the person. */
  message: string | null;
}

export interface StatusSchemaOptions {
  /** The step's own schema. With none, `result` is a string. */
  schema?: object;
  /** Whether the agent may ask the person. On unless the step says `ask: false`. */
  ask?: boolean;
}

/**
 * The JSON schema of a turn's answer: one flat object with `status`, `result` and `message`.
 * Every field is required and allows null, and the object allows no other field. `status` is
 * "done", "working" or "question", with no "question" when `ask` is false. `result` is the step's
 * schema, or a string when it has none. Each field has a description that tells the model what to
 * put there. Nullable fields use `anyOf` with `{ type: "null" }`, which both programs' schema
 * copies keep as written.
 */
export function statusSchema(options: StatusSchemaOptions = {}): Record<string, unknown> {
  const ask = options.ask !== false;
  const statuses: TurnStatusName[] = ask ? ["done", "working", "question"] : ["done", "working"];
  const status = [
    '"done": the task is finished, and result holds the answer.',
    '"working": there is more to do, and message says what is left. Asking whether to go on, or asking for leave to continue, is "working".',
    ...(ask ? ['"question": only for what you cannot decide or do without the person. message holds the question, and the person steps into this session to answer.'] : []),
  ];
  const message = ask
    ? 'With "working", what is left to do. With "question", the question for the person. null with "done".'
    : 'With "working", what is left to do. null with "done".';
  const result = options.schema
    ? 'With "done", the answer, as a value that fits this schema. null otherwise.'
    : 'With "done", the answer, as text. null otherwise.';
  return {
    type: "object",
    properties: {
      status: nullable({ type: "string", enum: statuses }, `Where the task stands. ${status.join(" ")}`),
      result: nullable(options.schema ?? { type: "string" }, result),
      message: nullable({ type: "string" }, message),
    },
    required: ["status", "result", "message"],
    additionalProperties: false,
  };
}

/** A field that allows the schema or null, with its description. */
function nullable(schema: object, description: string): Record<string, unknown> {
  return { anyOf: [schema, { type: "null" }], description };
}

/**
 * A turn's value as `{ status, result, message }`, or undefined when it is not one: not an
 * object, a field missing, a status not one of the three, or a message neither a string nor null.
 * It does not check `result` against the step's schema. Other fields are dropped.
 */
export function readStatus(value: unknown): TurnStatus | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (!("result" in fields)) return undefined;
  const { status, result, message } = fields;
  if (!STATUSES.has(status)) return undefined;
  if (message !== null && typeof message !== "string") return undefined;
  return { status: status as TurnStatusName, result, message };
}

const STATUSES = new Set<unknown>(["done", "working", "question"]);
