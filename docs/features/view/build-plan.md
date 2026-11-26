# Build plan for the sous view

How the mock becomes the real page that `sous serve` opens. Written on 2026-11-25, when the owner asked for the board wired end to end. Every builder reads this file first, then `DESIGN.md`, `states.md` and `design-flow.md` in this folder.

## What done means

The owner runs `sous serve` in a project. It prints a link and opens the page. The page shows every run in the sous home, live, with its steps, questions and costs. The owner answers a question, approves a breakpoint, stops, resumes and reruns runs, and starts a workflow, all from the page. They see the saved workflows as graphs, and the agents, skills and MCP servers with their building blocks. The page follows `DESIGN.md`, works at 375, 768 and 1440 px in light and dark, and passes axe.

## Choices made for the open questions

The intent left these open. The build takes the default below, and the owner can change any of them.

- Freshness: live. `/api/live` says what changed within about a second, and the page reads only that again.
- Runs: every run in the sous home, across projects, one line per run, grouped by project or by status.
- Who gets in: the server listens on 127.0.0.1 only. The link it prints carries a token, which becomes a cookie. Every API call needs the cookie or the token as a Bearer header, and the server checks the Host and Origin headers. An agent starts `sous serve` only with `--by person`, and a step of a run never does.
- The page acts as the person. Its writes go through the same sous commands the terminal runs, with `by: "person"` and `through: { kind: "person", via: "view" }`.
- Starting a workflow from the page is the person's own run, so it approves the text it runs. When the text changed since the last yes, the start dialog shows the diff first and asks to confirm.
- Workflows, agents, skills and MCP servers are read only, except for removing things.
- Removing a run removes one run that ended, from the list and the home. Its worktree stays.
- Removing a workflow moves its file to `<home>/trash/`, after a dialog that names the path.
- MCP secrets are masked. The page shows where sous reads each value.
- Agents, skills and MCP servers are seen from the project `sous serve` started in. "Seen from" switches to another project sous knows.
- The graph comes from the workflow's text. A run's graph lays its steps over the graph of the text the run started with, matched by label. When that fails, it shows the steps as they ran.

## The architecture

```
browser ──HTTP──> sous serve (packages/cli/src/serve) ──> engine reads and sous commands
   │                                                        │
   └── packages/view (React, built to packages/view/dist) <─┘ served as static files
```

- `packages/view/src/api/contract.ts` holds every type the server sends and the page reads. The cli imports them as `import type { ... } from "@sous/view"`, the view package's only entry. Change the contract first, then both sides.
- The server reads through engine functions. It never opens a run file itself.
- Every write the page makes goes through `POST /api/call` with the words of one sous command, such as `["answer", "q-1a2b", "yes"]`. The server runs that command in its own process, as the person through the view, and answers its JSON reply or its refusal. So the page gets the same consent rules, refusals and `events.jsonl` lines as the terminal. Only two writes have their own routes, since no command does them: removing a run and moving a workflow to the trash.
- `GET /api/live` is a server-sent event stream. The server watches the home and sends `{type: "changed", runs, questions, workflows, catalog}`. The page invalidates the matching TanStack Query keys (`src/api/queries.ts`).
- The page is hash-routed, so the server only serves `index.html` and the built assets.

## Rules for every builder

- Read `AGENTS.md` at the repo root. Tests never touch the real home. Run a package's tests with its own `pnpm --filter <pkg> test`.
- Never run `pnpm install` without `--ignore-scripts`. Never set `core.hooksPath`. Never commit. Never touch `~/.sous`, `~/.claude`, `~/.codex` or `~/.agents`: tests and demos use a temporary home through `SOUS_HOME` and `HOME`.
- `test/architecture.test.mjs` holds the architecture. Don't edit it. A new file that imports `fs`, `http`, `child_process` or another machine module must be listed in its `TOUCHES_MACHINE` table, so report the path and the owner of the build adds it. Respect the HOMES rules: `process.env` and `homedir(` only where the table allows them, and `CLAUDE_CONFIG_DIR` and `CODEX_HOME` only in the harness adapters. Every exported value needs an importer in `src`, not only in a test. Files stay under 850 lines and functions under 250.
- Each test file imports a run-time value from the code it tests.
- Comments and docs are plain, short sentences in the repo's voice. No emojis, no em dashes.
- The view: tokens only (`scripts/check-tokens.mjs` fails on raw colors and cleared Tailwind classes), UI SDK only behind our wrappers in `src/ui/`, explicit `.ts` and `.tsx` import extensions, sentence case, sous verbs on buttons. Every component shows every state on the `#/kit` page.
- The look follows `DESIGN.md`, which comes from the minimalist-ui skill and the owner's references. Use the impeccable skill's critique, audit and polish steps on what you build (`.claude/skills/impeccable/` in this repo), and `npx impeccable detect` on your files. Don't use the other style skills.
- The mock in `mock/` is the shape the owner accepted. Port its behavior, its copy and its layout code where it fits. Its data is fake, the page's is real.

## The work

Wave 1 runs at once, each builder in its own files.

1. Engine, the flow reader. `packages/engine/src/workflows/flow.ts` reads a workflow's text into the `Flow` tree of the contract, with acorn. Pure, no file access.
2. Engine, the catalog and the two removals. Skills and MCP servers found the way the harnesses find them, an agent's whole page, removing a run, moving a workflow to the trash, and `via: "view"` on the person's `Through`.
3. Cli, `sous serve`. The server, the routes, the live stream, the call route, the command, its tests and its section in `docs/guide.md`.
4. View, the parts. The UI SDK wrappers, markdown and code blocks, toasts, dialogs, menus, and the kit page sections.

Wave 2 starts as wave 1 lands.

5. View, the graph: overlay, layout and drawing, ported from `mock/run.js`.
6. View, the shell: the rail badge, the list column for each section with real data, search, keyboard, the connection bar and Settings.
7. View, the run page: header, the needs-you panel, the Steps view with its timeline and step dropdowns, and the actions.
8. View, the workflow, agent, skill and MCP pages, and the start dialog.

Wave 3 proves it.

- A real `sous serve` on a temporary home, with workflows of code steps, questions and breakpoints, driven by Playwright: answer, approve, stop, resume and start from the page, and see the runs change live.
- A demo home with stand-in agents for the richer states: tokens, costs, nested workflows, loops and long activity.
- The check loop of `design-flow.md`, at most three rounds, then the owner.

## Running it while building

- Server: `SOUS_HOME=<temp> node packages/cli/dist/cli.js serve --no-open --port 4317` after `pnpm --filter @sous/cli build`, or through tsx in tests.
- Page with hot reload: start the server with `SOUS_SERVE_TOKEN=dev`, then `SOUS_TOKEN=dev pnpm --filter @sous/view dev`. Vite proxies `/api` to port 4317 with the token as a Bearer header.
- Screenshots: `node packages/view/scripts/shot.mjs <out> <width> <light|dark> <route>...` with `BASE` set to the page's address.
