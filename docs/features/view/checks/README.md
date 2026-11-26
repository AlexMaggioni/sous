# UI check

`check.mjs` runs the same checks on every route of a single-page HTML mock. Run it again after each fix round (step 4 of `../design-flow.md`).

## Install

Run this once in a folder that holds `check.mjs` (any folder works, for example a scratch folder). It needs Google Chrome installed and downloads no browser.

```
npm init -y && npm pkg set type=module && npm install --ignore-scripts playwright-core axe-core
```

## Run

```
node check.mjs <file-or-url> --out <dir> [--widths 375,768,1440] [--themes light,dark] [--max-routes 80] [--routes routes.json] [--concurrency 4] [--no-shots] [--no-impeccable]
```

Example for the view mock:

```
node check.mjs ../mock/index.html --out /tmp/view-check
```

- Routes: the script follows every `a[href^="#"]` and every `data-route`, `data-go`, `data-href`, `data-to`, `data-link`, `data-path` or `data-navigate` value, breadth first, up to `--max-routes`. `--routes routes.json` replaces the crawl with a JSON array such as `["#/runs/new", "#/agents"]`.
- Theme: the script emulates the color scheme and clears localStorage before each load, so a stored theme choice cannot win.
- Output in `<out>`: `report.md` (pass or fail, the 10 top findings, totals, then findings by check), `report.json` (every finding), `shots/` (a viewport shot per route, width and theme, plus a `__full` shot when the page is taller than the viewport) and `impeccable.txt`.
- Sideways overflow: a visible scroll container at least 40% of the viewport wide (overflow-x auto, scroll, hidden or clip, no ellipsis) whose content is wider than its box is a failure. Put a `data-scroll-x` attribute on it or on an ancestor when it should scroll sideways on purpose, such as a graph canvas or a code block.
- Exit code 1 when there is an axe violation of impact serious or critical, a horizontal page scroll, sideways overflow in a container, a console error or a load error. Otherwise 0. Everything else is a warning.
- Impeccable runs through `npx --offline impeccable@4.5.2 detect`, so it needs that version in the npx cache. When it cannot run, the report says it was skipped.

## What it does not see

- Only elements visible at load. Open menus, dialogs and error states need their own route or a change to the script.
- An element scrolled out of its scroll container, or clipped by one, counts as not visible for the overlap and cut-off checks.
- The small-target check has no spacing exception (WCAG 2.5.8 allows a small target with enough space around it), so treat it as a warning to review.
