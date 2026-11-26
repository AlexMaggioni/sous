// sous serve's web server: the built page of packages/view and the API under /api, on 127.0.0.1
// only. Every request needs the token: from the cookie the printed link sets, or a Bearer header.
// A Host header that is not the server's own is refused, and so is a write with the cookie from
// another origin. This file, with cli.ts, holds the cli's machine access.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { knownProjects, projectWorkflows, workerProcess, type HomePaths, type Launcher } from "@sous-run/engine";
import type { ApiError, LiveEvent } from "@sous-run/view";
import type { CommandSpec } from "../commands/index.js";
import { catalogPrint } from "./catalog.js";
import { LiveFeed, type LiveTimes } from "./live.js";
import { answerApi } from "./routes.js";

export interface ServeOptions {
  paths: HomePaths;
  /** The project sous serve started in: the default for workflows, agents, skills and MCP. */
  project: string;
  /** The port to listen on. One in use moves to the next free one. 0 takes any free port. */
  port: number;
  /** Only 127.0.0.1. */
  host: string;
  /** Default: a random one. */
  token?: string;
  /** Starts the workers of the runs a call starts or resumes. Default: a process each. */
  launch?: Launcher;
  /** The sous commands, for POST /api/call. */
  commands: Record<string, CommandSpec>;
  /** What the commands and the catalog read. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** The built page. Default: $SOUS_VIEW_DIR, else packages/view/dist. */
  viewDir?: string;
  /** Gets a line for each request sous itself failed. */
  log?: (line: string) => void;
  /** How often the live stream reads the home. */
  live?: Partial<LiveTimes>;
}

export interface Served {
  /** The link to open: it sets the cookie and goes to the page. */
  url: string;
  origin: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** How many ports after the one asked for a server tries. */
const PORT_TRIES = 20;
/** The most a request body may hold. */
const BODY_MAX = 1024 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const SAFE = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };

/** A short page for the browser, in sous's words. */
function note(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>sous</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#222;background:#fafafa}@media (prefers-color-scheme:dark){body{color:#ddd;background:#161616}}code{font-family:ui-monospace,monospace}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;
}

const NO_TOKEN_PAGE = note("Open the link sous serve printed", "This page needs the token in the link <code>sous serve</code> printed in its terminal. Open that link, and the page remembers it.");
const NOT_BUILT_PAGE = note("The page is not built", "Run <code>pnpm --filter @sous-run/view build</code> in the sous repository, then reload.");

const NO_TOKEN: ApiError = { code: "no_token", message: "this call needs the token sous serve printed.", change: "Open the link sous serve printed, or send the header Authorization: Bearer <token>.", call: null };

/** Two secrets compared in constant time. */
function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The built page's folder, or undefined when sous can't find it. A published sous carries the
 *  page in its own view/ folder. A build of the repository takes it from packages/view. */
function viewFolder(options: ServeOptions, env: NodeJS.ProcessEnv): string | undefined {
  if (options.viewDir) return resolve(options.viewDir);
  if (env.SOUS_VIEW_DIR) return resolve(env.SOUS_VIEW_DIR);
  const carried = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "view");
  if (existsSync(join(carried, "index.html"))) return carried;
  try {
    return join(dirname(createRequire(import.meta.url).resolve("@sous-run/view/package.json")), "dist");
  } catch {
    return undefined;
  }
}

/** The version of the cli that serves, from its package.json, the same from src and dist. */
function cliVersion(): string {
  try {
    return (createRequire(import.meta.url)("../../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** sous's workers, each a process that runs the built cli.js. */
function workers(): Launcher {
  const here = dirname(fileURLToPath(import.meta.url));
  return workerProcess(() => {
    const file = [join(here, "..", "cli.js"), join(here, "..", "..", "dist", "cli.js")].find((candidate) => existsSync(candidate));
    if (!file) throw new Error("sous is not built. Run pnpm build in the sous repo.");
    return file;
  });
}

/** A stamp of files and of what folders hold, which changes when one of them changes. */
function stampOf(dirs: string[], files: string[]): string {
  const stamp = (file: string) => {
    const stat = statSync(file, { throwIfNoEntry: false });
    return stat ? `${file}:${stat.mtimeMs}:${stat.size};` : `${file}:-;`;
  };
  let text = "";
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      // A folder that is not there yet stamps as empty.
    }
    text += `${dir}[${names.map((name) => stamp(join(dir, name))).join("")}]`;
  }
  return text + files.map(stamp).join("");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        fail(new RangeError("body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** Listen on the port, or the next free one when it is taken. */
async function listen(server: ReturnType<typeof createServer>, host: string, port: number): Promise<number> {
  for (let tried = 0; ; tried++) {
    const at = port === 0 ? 0 : port + tried;
    try {
      await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(at, host, () => {
          server.off("error", fail);
          done();
        });
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : at;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || port === 0 || tried >= PORT_TRIES) throw error;
    }
  }
}

/** Start the server. It runs until close(). */
export async function startServer(options: ServeOptions): Promise<Served> {
  if (options.host !== "127.0.0.1") throw new Error(`sous serve listens on 127.0.0.1 only, not ${options.host}.`);
  const env = options.env ?? process.env;
  const token = options.token ?? randomBytes(24).toString("base64url");
  const { paths, project } = options;
  const view = viewFolder(options, env);
  let launcher: Launcher | undefined;
  const context = {
    paths,
    project,
    version: cliVersion(),
    env,
    commands: options.commands,
    launch: ((...args) => (options.launch ?? (launcher ??= workers()))(...args)) as Launcher,
  };
  const live = new LiveFeed(
    paths,
    {
      workflows: () => stampOf([...new Set([project, ...knownProjects(paths)].flatMap((dir) => projectWorkflows(paths, dir).dirs))], [paths.approvals]),
      catalog: () => {
        const { text, files } = catalogPrint(paths, project, env);
        return text + stampOf([], files);
      },
    },
    options.live,
  );
  const streams = new Set<ServerResponse>();
  let port = 0;
  const hosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const cookie = () => `sous_${port}`;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SAFE });
    res.end(JSON.stringify(body));
  };
  const html = (res: ServerResponse, status: number, page: string) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SAFE });
    res.end(page);
  };
  const refuse = (res: ServerResponse, status: number, code: string, message: string, change: string) => json(res, status, { error: { code, message, change, call: null } });

  /** How the request shows the token: the cookie, a Bearer header, or not at all. */
  const authOf = (req: IncomingMessage): "cookie" | "bearer" | undefined => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
    if (bearer && same(bearer, token)) return "bearer";
    const kept = cookieOf(req.headers.cookie, cookie());
    return kept && same(kept, token) ? "cookie" : undefined;
  };

  const stream = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no", ...SAFE });
    res.write("retry: 2000\n\n");
    streams.add(res);
    // The close comes first, so a page whose add fails still leaves the streams.
    let remove: (() => void) | undefined;
    req.on("close", () => {
      remove?.();
      streams.delete(res);
    });
    remove = live.add({ send: (event: LiveEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`), ping: () => res.write(": ping\n\n") });
  };

  const page = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (req.method !== "GET" && req.method !== "HEAD") return refuse(res, 405, "wrong_method", `${pathname} takes GET, not ${req.method}.`, "Send GET.");
    const index = view ? join(view, "index.html") : undefined;
    if (!index || !existsSync(index)) return html(res, 503, NOT_BUILT_PAGE);
    let wanted: string;
    try {
      wanted = pathname === "/" ? index : resolve(view!, `.${decodeURIComponent(pathname)}`);
    } catch {
      return refuse(res, 400, "bad_argument", `"${pathname}" is not a path.`, "Give a path of the page.");
    }
    // A NUL in the path makes statSync throw, so it is a file the page does not have.
    const stat = wanted.startsWith(view! + sep) && !wanted.includes("\0") ? statSync(wanted, { throwIfNoEntry: false }) : undefined;
    if (!stat?.isFile()) return html(res, 404, note("Not found", "The page has no such file. Open the link sous serve printed."));
    const hashed = wanted.startsWith(join(view!, "assets") + sep);
    res.writeHead(200, { "content-type": TYPES[extname(wanted).toLowerCase()] ?? "application/octet-stream", "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache", ...SAFE });
    res.end(req.method === "HEAD" ? undefined : readFileSync(wanted));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // A page another site opens by a name that points here sends its own Host.
    if (!hosts().includes(req.headers.host ?? "")) return refuse(res, 403, "bad_host", `sous serve answers only ${hosts().join(" and ")}.`, `Open http://127.0.0.1:${port}/ as sous serve printed it.`);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    const given = url.searchParams.get("t");
    if (!isApi && req.method === "GET" && given !== null && same(given, token)) {
      res.writeHead(302, { location: "/", "set-cookie": `${cookie()}=${token}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store", ...SAFE });
      return res.end();
    }
    const auth = authOf(req);
    if (!isApi) return auth ? page(req, res, url.pathname) : html(res, 401, NO_TOKEN_PAGE);
    if (!auth) return json(res, 401, { error: NO_TOKEN });
    const write = !["GET", "HEAD"].includes(req.method ?? "GET");
    // The Vite dev server proxies with the token as a Bearer header, so only the cookie needs the origin.
    if (write && auth === "cookie" && !hosts().some((host) => req.headers.origin === `http://${host}`)) {
      return refuse(res, 403, "bad_origin", `a write with the cookie must come from the page sous serve serves, not ${req.headers.origin ?? "no origin"}.`, "Make the call from the page, or send the token as a Bearer header.");
    }
    if (url.pathname === "/api/live") return req.method === "GET" ? stream(req, res) : refuse(res, 405, "wrong_method", `/api/live takes GET, not ${req.method}.`, "Send GET.");
    let body: unknown;
    try {
      const text = await readBody(req);
      if (text.trim()) {
        if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return refuse(res, 415, "bad_argument", "a request body must be JSON.", "Send the header Content-Type: application/json.");
        body = JSON.parse(text);
      }
    } catch (error) {
      if (error instanceof RangeError) return refuse(res, 413, "bad_argument", "the request body is over 1 MB.", "Send less.");
      return refuse(res, 400, "bad_argument", "the request body is not JSON.", "Send a JSON body, such as {\"argv\": [...]}.");
    }
    const answer = await answerApi(context, req.method ?? "GET", url.pathname.slice("/api/".length), url.searchParams, body);
    if (answer.status >= 500) options.log?.(`sous serve: ${req.method} ${url.pathname} failed: ${(answer.body as { error: ApiError }).error.message}`);
    json(res, answer.status, answer.body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      options.log?.(`sous serve: ${req.method} ${req.url} failed: ${(error as Error).stack ?? String(error)}`);
      if (!res.headersSent) refuse(res, 500, "internal", "sous serve failed on this request.", "Read the server's terminal, fix the cause and try again.");
      else res.end();
    });
  });
  port = await listen(server, options.host, options.port);
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/?t=${encodeURIComponent(token)}`,
    origin,
    port,
    token,
    close: () =>
      new Promise<void>((done) => {
        live.close();
        for (const res of streams) res.end();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
