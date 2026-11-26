# @sous-run/view

The page `sous serve` opens: every run in the sous home, live, with its steps, questions and costs, and the saved workflows, agents, skills and MCP servers. The cli serves the built files from `dist/` and the API under `/api`.

## Run it

- Build once: `pnpm --filter @sous-run/view build`. Then `sous serve` in a project prints a link and opens it.
- With hot reload: start the server with `SOUS_SERVE_TOKEN=dev sous serve --no-open`, then `SOUS_TOKEN=dev pnpm --filter @sous-run/view dev` and open http://localhost:5199. Vite sends `/api` to port 4317 with the token.
- On a throwaway world, with runs that wait, run, fail and retry on fake agents: `node packages/view/e2e/serve.mjs --port 4431 --token demo --runs`, then open http://127.0.0.1:4431/?t=demo. Nothing touches your own sous home.
- Tests: `pnpm --filter @sous-run/view test`. Type check: `pnpm --filter @sous-run/view typecheck`. Tokens: `node scripts/check-tokens.mjs`.
- End-to-end checks against a real `sous serve`, in the installed Chrome: build the cli and the page, then `pnpm --filter @sous-run/view test:e2e`.

## Where things are

- `src/api/`: `contract.ts` holds every type the server sends, `client.ts` the fetch calls, `queries.ts` one hook per read and write, `live.ts` the event stream.
- `src/ui/`: the parts every page uses, each a wrapper on UI SDK styled with the tokens. `motion.ts` holds the motions that need script, as `DESIGN.md` says under Motion.
- `src/graph/`: the graph of a workflow or a run.
- `src/plan/`: what the Graph view, the Steps view and the step panel share. `plan.ts` builds the plan of a workflow or a run and says where a step sits, `rows.ts` makes the Steps rows, `step-about.tsx` says what a step is, and `plan-view.tsx` puts a view and the panel together for both pages.
- `src/shell/`: the rail, the list column and the page frame around the pages.
- `src/pages/`: one folder per page.
- `src/start/`: the start dialog.
- `src/kit/`: the `#/kit` page, which shows every part in every state.
- `src/styles/`: the tokens of `DESIGN.md` and the base styles.

The look follows `DESIGN.md` and the product brief `PRODUCT.md`. The plan the page was built from is `docs/features/view/build-plan.md`.
