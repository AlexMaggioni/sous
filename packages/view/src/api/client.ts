import type { ApiError, CallReply, CallRequest, NextCall } from "./contract.ts";

// The one way the page talks to `sous serve`. The server set a cookie when the page opened from
// the link it printed, so every request carries it on its own.

/** A failed request, with sous's own words for it. */
export class SousError extends Error {
  readonly code: string;
  readonly change: string;
  readonly call: string | null;
  readonly next?: NextCall[];
  readonly status: number;

  constructor(error: ApiError, status: number) {
    super(error.message);
    this.name = "SousError";
    this.code = error.code;
    this.change = error.change;
    this.call = error.call;
    if (error.next) this.next = error.next;
    this.status = status;
  }
}

/** A read tries once more when the server could not answer, never when it refused, such as a
 *  run that is not there. */
export function retryOnce(failures: number, error: Error): boolean {
  return failures < 1 && !(error instanceof SousError && error.status >= 400 && error.status < 500);
}

/** What the page says when it can't reach the server at all. */
const UNREACHABLE: ApiError = {
  code: "unreachable",
  message: "The page can't reach sous serve.",
  change: "Run sous serve again, then reload the page.",
  call: "sous serve",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, { ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  } catch {
    throw new SousError(UNREACHABLE, 0);
  }
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const error = (body as { error?: ApiError } | undefined)?.error;
    throw new SousError(error ?? { ...UNREACHABLE, code: "bad_answer", message: `sous serve answered ${response.status}.` }, response.status);
  }
  return body as T;
}

/** A path with its query, leaving out the values that are not set. */
export function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export const getJson = <T>(path: string): Promise<T> => request<T>(path);

/** Run one sous command as the person. A refusal comes back as a SousError, so callers handle
 *  every failure the same way. */
export async function callSous(argv: string[]): Promise<Extract<CallReply, { ok: true }>> {
  const body: CallRequest = { argv };
  const reply = await request<CallReply>("call", { method: "POST", body: JSON.stringify(body) });
  if (!reply.ok) throw new SousError(reply.error, 200);
  return reply;
}

export const deleteJson = <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" });
export const postJson = <T>(path: string, body: unknown = {}): Promise<T> => request<T>(path, { method: "POST", body: JSON.stringify(body) });
