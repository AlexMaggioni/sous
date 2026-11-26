# Product

The page `sous serve` opens. Taken from the agreed intent in `docs/features/view/intent.json` and the choices in `docs/features/view/build-plan.md`. The look is in `DESIGN.md`, a link to `docs/features/view/DESIGN.md`.

## Platform

web

## Stack

React 19, Vite, Tailwind 4 on the tokens in `src/styles/tokens.css`, TanStack Router and Query, UI SDK behind the wrappers in `src/ui/`. The server is the sous cli, on 127.0.0.1.

## Users

One person, on their own Mac, who runs workflows of Claude Code and Codex agents with sous. A developer who knows the sous commands and reads code, prompts and logs all day.

## Product Purpose

Today sous is seen only through the terminal and macOS notices. A person following several runs has no place to see them at a glance, and event-driven workflows will add runs nobody watches. The page shows every run live, with its steps, questions and costs, and lets the person answer, approve, stop, resume, rerun and start runs. It also shows the saved workflows as graphs, and the agents, skills and MCP servers with their building blocks.

## Positioning

A local tool for one person, not a hosted dashboard. It sits next to the terminal and does what the sous commands do, with the same rules and refusals.

## Operating Context

Opened on demand from `sous serve`, beside an editor and terminals. The person comes back after time away, watches a run, answers a question, or looks at why a run failed and what it cost.

## Capabilities and Constraints

- Live within about a second, through a server-sent event stream.
- Every run in the sous home, across projects, one line per run, grouped by project or by status.
- Workflows, agents, skills and MCP servers are read only, except removing a run that ended and moving a workflow file to the trash.
- MCP secrets are masked.
- Only the person's browser gets in: a token in the printed link, a cookie, Host and Origin checks.

## Brand Commitments

Flat, neutral and quiet. Copper means "needs you" and nothing else. Serif page titles, sans for the rest, mono for code and ids. See `DESIGN.md`.

## Evidence on Hand

The accepted mock in `docs/features/view/mock/`, its screenshots, the references in `docs/features/view/references/`, `states.md` for every state, and `design-flow.md` for the check loop.

## Product Principles

- Show what needs the person first.
- Every page is decluttered and still gives all the information.
- Every write goes through the same sous command the terminal runs.

## Accessibility & Inclusion

Keyboard first with a visible focus. Axe clean. Works at 375, 768 and 1440 px, in light and dark with the same care. No motion with reduced motion.
