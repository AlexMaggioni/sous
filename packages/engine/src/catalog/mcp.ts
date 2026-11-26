// The MCP servers sous sees from a project, read from the files a step's servers come from:
// rulesync's mcp.jsonc, then each harness's own config (mcpSources in agents.ts). A server in
// rulesync is seen by both harnesses, one in a harness's config by that harness alone.
//
// No value that may hold a secret leaves whole. An env or header value that names variables, such
// as "${LINEAR_API_KEY}" or "Bearer ${TOKEN}", shows as written, since the variable holds the
// secret, and `from` says where sous reads it. Any other env or header value shows as "••••", with
// its last four characters when it has 16 or more. The command, the args, the url and every other
// string of the entry go through redactText, a url's query values are hidden, and an arg that
// follows a flag such as --token is hidden too.

import { resolve, sep } from "node:path";
import { stringify as toToml } from "smol-toml";
import { HARNESSES, lookupAgents, lookupSettings, mcpSources, type LookupSettings, type McpSource } from "../agents.js";
import { redactText } from "../redact.js";
import { loadConfig, loadSecrets, type HomePaths } from "../runs/home.js";
import type { McpPage, McpRow, McpValue } from "./types.js";
import { savedCalls, usedBy } from "./used-by.js";

type Env = Record<string, string | undefined>;
type Entry = Record<string, unknown>;

const MASK = "••••";
/** A literal shows its last four characters only when it has at least this many. */
const SHOW_END_FROM = 16;
/** The keys of an entry that hold an env or header value by name. */
const VALUES = new Set(["env", "environment", "headers", "http_headers"]);
/** A flag whose next arg is a secret. */
const SECRET_FLAG = /^--?[\w-]*(key|token|secret|password|passwd|auth|credential|cookie)[\w-]*$/i;
/** A ${NAME} reference, which names a variable and holds no secret itself. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const REFERENCE_PART = /(\$\{[A-Za-z_][A-Za-z0-9_]*\})/;

const isEntry = (value: unknown): value is Entry => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Text that is only ${NAME} references. */
const onlyReferences = (text: string) => text.trim() !== "" && text.replace(REFERENCE, "").trim() === "";

/** Text with every credential redactText finds hidden. The references stay, so a long variable
 *  name never reads as a token. */
const hide = (text: string) =>
  text
    .split(REFERENCE_PART)
    .map((part, i) => (i % 2 ? part : redactText(part).value.replace(/\[REDACTED\]/g, MASK)))
    .join("");

/** A url with its user, its password and its query values hidden, unless a value only names variables. */
const hideUrl = (url: string) => hide(url.replace(/([?&][^=&#]+=)([^&#]*)/g, (_, key: string, value: string) => key + (value === "" || onlyReferences(value) ? value : MASK)));

/** Args with credentials hidden, and the arg after a flag such as --token, unless it only names variables. */
const hideArgs = (args: string[]) => args.map((arg, i) => (i > 0 && SECRET_FLAG.test(args[i - 1]!) && !onlyReferences(arg) ? MASK : hide(arg)));

/** One env or header value as a page may show it, and where sous reads it. */
function maskValue(key: string, value: string, secrets: Record<string, string>): McpValue {
  const names = [...value.matchAll(REFERENCE)].map((match) => match[1]!);
  if (names.length) {
    const from = [...new Set(names.map((name) => (Object.hasOwn(secrets, name) ? "secrets.env" : "the environment")))].join(" and ");
    return { key, value: hide(value), secret: true, from };
  }
  return { key, value: value.length >= SHOW_END_FROM ? `${MASK}${value.slice(-4)}` : MASK, secret: redactText(`${key}=${value}`).redacted };
}

function maskValues(value: unknown, secrets: Record<string, string>): McpValue[] {
  return isEntry(value) ? Object.entries(value).map(([key, item]) => maskValue(key, String(item), secrets)) : [];
}

/** The entry with its env and header values masked and every other string hidden. */
function maskEntry(value: unknown, secrets: Record<string, string>, key?: string): unknown {
  if (key !== undefined && VALUES.has(key) && isEntry(value)) return Object.fromEntries(maskValues(value, secrets).map((pair) => [pair.key, pair.value]));
  if (key === "args" && Array.isArray(value)) return hideArgs(value.map(String));
  if (key === "url" && typeof value === "string") return hideUrl(value);
  if (typeof value === "string") return hide(value);
  if (Array.isArray(value)) return value.map((item) => maskEntry(item, secrets));
  if (isEntry(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskEntry(item, secrets, name)]));
  return value;
}

const urlOf = (entry: Entry) => (typeof entry.url === "string" ? entry.url : typeof entry.httpUrl === "string" ? entry.httpUrl : undefined);

/** How a step reaches the server, read as a step's lookup reads it. */
function transport(entry: Entry): McpRow["type"] {
  if (urlOf(entry) && entry.type !== "stdio") return entry.type === "sse" ? "sse" : "http";
  return "stdio";
}

/** A file as the page names it: from the project, from the home folder as ~, else whole. */
function shortFile(file: string, settings: LookupSettings): string {
  const project = resolve(settings.projectDir);
  const home = settings.env?.HOME ? resolve(settings.env.HOME) : undefined;
  if (file.startsWith(project + sep)) return file.slice(project.length + 1);
  if (home && file.startsWith(home + sep)) return `~/${file.slice(home.length + 1)}`;
  return file;
}

interface Defined {
  source: McpSource;
  entry: Entry;
}

/** The servers of every file that parses, by name, each name's files in the order they win:
 *  rulesync's, then the default harness's own, then the other harness's. */
function findServers(settings: LookupSettings): Map<string, Defined[]> {
  const rank = (source: McpSource) => (source.from === "rulesync" ? 0 : source.from === settings.defaultHarness ? 1 : 2);
  const sources = mcpSources(settings)
    .filter((source) => !source.error)
    .sort((a, b) => rank(a) - rank(b));
  const servers = new Map<string, Defined[]>();
  for (const source of sources) {
    for (const [name, entry] of Object.entries(source.servers)) {
      if (isEntry(entry)) servers.set(name, [...(servers.get(name) ?? []), { source, entry }]);
    }
  }
  return servers;
}

function rowOf(name: string, defined: Defined[], settings: LookupSettings): McpRow {
  const seenBy = HARNESSES.filter((harness) => defined.some(({ source }) => source.from === "rulesync" || source.from === harness));
  return { name, type: transport(defined[0]!.entry), seenBy, source: shortFile(defined[0]!.source.file, settings) };
}

/** The MCP servers seen from a project, by name. A config file that does not parse is skipped. */
export function listMcpServers(paths: HomePaths, projectDir: string, env?: Env): McpRow[] {
  const settings = lookupSettings(paths, projectDir, loadConfig(paths), env);
  return [...findServers(settings).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, defined]) => rowOf(name, defined, settings));
}

/** One MCP server's page, from the file that wins, with every secret masked. Undefined when no
 *  file defines the name. */
export function mcpPage(paths: HomePaths, projectDir: string, name: string, env?: Env): McpPage | undefined {
  const settings = lookupSettings(paths, projectDir, loadConfig(paths), env);
  const defined = findServers(settings).get(name);
  if (!defined) return undefined;
  const row = rowOf(name, defined, settings);
  const { source, entry } = defined[0]!;
  const secrets = loadSecrets(paths);
  const listed = Array.isArray(entry.command) ? entry.command.map(String) : undefined;
  const command = listed ? listed[0] : typeof entry.command === "string" ? entry.command : undefined;
  const args = listed ? listed.slice(1) : Array.isArray(entry.args) ? entry.args.map(String) : [];
  const url = urlOf(entry);
  const masked = { [name]: maskEntry(entry, secrets) };
  return {
    ...row,
    ...(row.type === "stdio" && command !== undefined ? { command: hide(command), args: hideArgs(args) } : {}),
    ...(row.type !== "stdio" && url !== undefined ? { url: hideUrl(url) } : {}),
    env: row.type === "stdio" ? maskValues(listed ? (entry.environment ?? entry.env) : entry.env, secrets) : [],
    headers: row.type === "stdio" ? [] : maskValues(entry.headers ?? entry.http_headers, secrets),
    files: defined.map(({ source: file }) => ({ file: file.path, scope: file.scope, harness: file.from })),
    usedBy: usedBy(lookupAgents(settings), savedCalls(paths, projectDir), "mcp", name),
    raw: source.from === "codex" ? tomlOf(masked) : JSON.stringify(masked, null, 2),
  };
}

/** The entry as Codex's config.toml writes it, or as JSON when TOML can't hold a value. */
function tomlOf(masked: Record<string, unknown>): string {
  try {
    return toToml({ mcp_servers: masked });
  } catch {
    return JSON.stringify(masked, null, 2);
  }
}
