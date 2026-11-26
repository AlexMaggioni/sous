# DESIGN.md for the sous view

The rules every page of the view follows. Each rule has its reason. The owner picked the references on 2026-11-24: Paradev for the shell, Vercel Workflows for a run's detailed view, GitHub Actions for the graph overview, and Linear for the feed. The details Inngest and Trigger.dev show for a step sit in its panel under the view. Screens are in `references/`.

The owner reviewed mock v3 on 2026-11-25 and asked for less visual noise: a neutral palette close to Paradev's, a sidebar like `references/paradev-sidebar.png`, a graph with arrows and drawn loops, and clearer pages for workflows, agents, skills and MCP servers. This version of the file holds those changes.

## Look

Flat, neutral and quiet. The page is gray, and color marks only three states: running, failed and needs you. Reason: the person opens the view to answer a question or see what failed, and color is the fastest way to find either. When everything has color, nothing stands out.

- No gradients, no shadows except a 1px border, no pill-shaped containers, no emojis.
- No card grids. Sections are a heading and space. No divider lines between sections. Reason: v3 had rules, boxes and outlines everywhere, and the owner read it as noise.
- At most one bordered box per page, for code, markdown or the graph canvas.
- No fact shown twice in one row or node. A list where every row is the same kind has no per-row kind icon, since the rail already says the kind.
- No ALL-CAPS eyebrows above content, no meta strings joined with middle dots, no "→" on buttons. Section labels are sentence case.
- Radius is 6px on controls and nodes, 8px on panels and dialogs.

## Theme and color

The theme follows the system with `prefers-color-scheme`. The mock menu in the rail can override it for review. The grays are Paradev's own tokens, read from the installed app.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | #fafaf8 | #151110 | center pane |
| `--bg-side` | #eceae8 | #1a1716 | list column |
| `--bg-rail` | #e3e0dd | #2f2b2a | rail, a step lighter in dark as Paradev's rail is |
| `--bg-raised` | #ffffff | #201e1c | inputs, an open step, menus, dialogs, the secondary button |
| `--bg-hover` | text at 5% | text at 5% | row hover |
| `--bg-selected` | text at 9% | text at 8% | selected row |
| `--border` | #e2e0de | #2a2827 | the one box per page, node borders |
| `--border-strong` | #d8d6d4 | #3a3837 | input borders |
| `--edge` | #a19e9b | #5a5754 | graph edges and arrowheads |
| `--text` | #2c2a28 | #eae8e6 | names, titles, values, the agent's words |
| `--text-muted` | #625f5d | #a8a5a3 | labels, meta, the activity feed |
| `--icon-muted` | #7a7774 | #8a8683 | every gray icon, never text |

Status colors. Only three states have a color. The rest are gray and differ by shape.

| Status | Light | Dark | Tint, for a timeline bar |
| --- | --- | --- | --- |
| running | #3580C2 | #8EC5F0 | blue at 12% |
| failed | #9F2F2D | #EC7D78 | red at 12% |
| needs you | #B5602A, text #9A4A1E | #DB8550 | copper at 12% |
| done, paused, stopped, queued, skipped | `--icon-muted` | `--icon-muted` | text at 6% |

- Color goes on the status icon and on a timeline bar only. Status words, such as "Running" in a header, are in `--text`. Reason: one colored mark per item is enough to find it.
- Running is light blue, an owner pick on 2026-11-25, so live runs stand out without competing with copper and red.
- Copper means "needs you" and nothing else. It is the brand color, and a question is the one thing the person must act on.
- The primary button is ink on light and cream on dark, never a status color.
- Every text pair is at least 4.5:1, icons that carry meaning at least 3:1.
- Links in running text are underlined.

## Status icons

Line icons, 14px, drawn with a 1.5px stroke. Only the needs-you dot is filled, so it is the first mark the eye finds.

| Status | Shape | Color |
| --- | --- | --- |
| queued | hollow dot | gray |
| running | ring with a moving arc | blue |
| done | check | gray |
| paused | two bars | gray |
| stopped | small square | gray |
| skipped | dash | gray |
| failed | × | red |
| needs you | filled dot | copper |

The same icon appears in the list row, the run header, the step row and the graph node. A reader tells every status apart by shape alone.

## Type

- IBM Plex Sans for the interface. Newsreader for page titles only. On 2026-11-25 the owner asked for a better title font than Plex Serif, and `mock/title-fonts.html` compares the options. IBM Plex Mono for paths, code, commands, run ids, tabular numbers, and the step names in the Steps view, as Vercel does. A setting value such as a model name is sans. Reason: v3 used mono for plain values, which added noise.
- Two weights: 400 and 500. No 600 or bold in the interface.
- The real app bundles the font files, since `sous serve` must work offline. The mock may load them from Google Fonts.

| Role | Size and weight | Notes |
| --- | --- | --- |
| Page title | Newsreader 24px, 500 | One per page |
| Section heading | 13px, 500, `--text` | Sentence case |
| Body, row names, values | 13px, 400 | Line height 1.45 |
| Labels and meta | 12px, 400, `--text-muted` | The smallest text size |
| Mono data | Plex Mono 12px | `font-variant-numeric: tabular-nums` |
| Rendered markdown | 14px, line height 1.6 | At most 72 characters per line |

Numbers are tabular and use one format everywhere. Durations read `840ms`, `12s`, `4m 08s`, `1h 12m`. Tokens read `12.4k`. Cost reads `$0.42`. Times are relative under a day, such as `3m ago`, with the full date in a tooltip.

## Buttons

Three kinds, the same everywhere. Reason: v3 mixed outlined buttons, segmented controls and filled buttons, and the owner asked for one clean visual language.

- Primary: solid `--ink` with `--on-ink` text. One per page at most.
- Secondary: `--bg-raised` fill in the sidebar, `--bg-hover` fill on the page, no border. Such as "Start a workflow".
- Icon: a 28px square, a gray 16px icon, no fill until hover. Each one has a tooltip that names the action and its key, such as "Hide sidebar ⌘B".
- Heights: 28px in the sidebar, 32px in page headers. Radius 6px. A leading icon is 16px with a 6px gap.
- No outlined buttons. No segmented controls in the sidebar. A two-way switch on a page, such as Rendered and Raw, is two quiet buttons where the chosen one has the `--bg-selected` fill.
- Menus open under their button on `--bg-raised` with a 1px `--border`, rows 28px, and close on Escape and outside click.

## Space and density

- A 4px scale: 4, 8, 12, 16, 24, 32, 48.
- Rows in the list column are 28px, rail icons 36px squares. Step rows are 36px. Under 700px wide, every row is at least 40px tall for touch.
- Every control is at least 24px by 24px.
- Items in a group sit 0 to 4px apart, groups 16 to 24px apart, page sections 32px apart. Space does the grouping that dividers did in v3.

## Layout

Three columns, as in Paradev.

1. The rail, 52px. At the top, the sidebar button. Then Runs, Workflows, Agents, Skills and MCP, each a gray line icon with its name in a tooltip. The Runs icon carries a copper count of runs that need you. At the bottom: Settings, and the mock menu, which holds the States list and the theme override. The "Sample data" label stays.
2. The list column, 280px. It can be hidden.
3. The center, the item picked. Its content is at most 1080px wide.

The list column follows `references/paradev-sidebar.png`.

- No title row. It opens with the section's create action, when it has one, then Search. Runs and Workflows open with "Start a workflow", a secondary button with a plus. Search is a plain row with a gray search icon and the word Search, with `/` shown muted at its right. It opens the one search.
- Group by, the project filter and "Seen from" live in one icon menu, at the right of the first section heading. The icon gets a small dot when a filter other than the default is on.
- Section headings are 12px, 500, `--text-muted`, sentence case, with the count after the name. "Needs you" is the first group when it has rows, and it uses `--needs-text`. A press on a heading folds its group, and a chevron shows on hover and while folded. This browser keeps the folds.
- A run row is one line: the status icon, the run's title in `--text`, and the workflow name in `--text-muted`. The project name is left out inside a project group. On hover and on focus, the age and the x appear at the right. Reason: the owner picked time on hover on 2026-11-25.
- A long title fades out at the right edge instead of ending in an ellipsis, and the full title shows in a tooltip.
- In the Workflows, Agents, Skills and MCP lists, a row is the name alone. A mark shows only when something is off: a copper dot and "changed" for a workflow changed since it was approved, a red × and "problem" for a check problem. An agent that runs on one harness only shows "Codex only" or "Claude Code only" muted at the right.

Hiding the list column.

- ⌘B on macOS and Ctrl+B elsewhere hide and show it. The sidebar button at the top of the rail does the same, with the tooltip "Hide sidebar ⌘B" or "Show sidebar ⌘B".
- When hidden, the rail stays with its badge, and the center takes the width. The choice is kept in `localStorage`.

Widths.

- At 1100px and up, all three columns show, unless the person hid the list.
- From 700 to 1099px, the list column folds away. The sidebar button opens it as an overlay, and Escape closes it.
- Under 700px, the rail becomes a top bar with the sidebar button and the five sections and the list opens full width. No page scrolls sideways. Wide content, such as the graph or code, scrolls inside its own box, which carries `data-scroll-x`, a visible scroll bar and keyboard focus.

## A run

The run page has two views of the same run, switched by a two-way switch under the header. Graph is the default, Steps is the detailed view. A press on a step, in either view, selects it and opens its panel under the view. The view stays as it was, so the person acts on the step and keeps the graph in sight. The owner asked for it on 2026-11-25. Both the view and the selected step stay in the URL hash, as `?view=steps` and `?step=`.

The header, as Vercel does it.

- The workflow name as the serif title, then the run id in mono with a copy button, then the status icon and label.
- One row of label and value pairs: Project, Started, Finished once it ends, Duration, Tokens, Cost.
- At most one primary action, picked by the state. When a question waits, the primary is in the question panel and the header has none. Resume is the primary when paused or failed, and nothing is when done. Stop is a quiet secondary button while it runs. Delete is in the "More" menu.

Needs you. When a question, an approval or a breakpoint waits, a panel sits between the header and the views. It has a 3px copper left edge, the step it comes from, a dim line on what the agent did before asking that opens to its last activity and message, the question in 14px text, and the controls to answer it. Once answered, the answer shows where the question was.

The Steps view, as Vercel does it.

- Left, the step rows. A group's row has a chevron that folds it, then each row has the status icon, the step name in mono, and the duration right-aligned. Parallel branches, pipeline stages, loops and nested workflows indent 16px under their parent, with a thin guide line. A branch of more than one step, and each branch of an if, has a row with its name. The rows come from the same plan the graph draws, so a step shows once in both, under the same name. A step that ran in each round of a loop is one row, with a bar per call.
- Right, a timeline. Running and failed bars have their status tint and a 1px border in their color. Every other bar is a gray tint with a 1px `--border-strong` edge. A running bar has no right edge and grows. A queued step has no bar.
- Under 900px the timeline hides and the rows take the full width.

## The step panel

The selected step's panel sits under the Graph or Steps view, on `--bg-raised`, on the workflow page and the run page alike. It first sat at the right of the view, and the owner moved it under on 2026-11-25, since the page has more room below than beside. The owner asked on 2026-11-25 for a way to read a step that shows what it is and the settings that matter, so the person never needs the Source view to understand it.

- It takes the width of the view. Once the panel is 760px wide, its body has two columns: what the person can do, what the step did and what it is on the left, and the call's facts, the settings and where it sits in a column of 260 to 320px on the right. Narrower, it is one column, in this order: what the person can do, the facts, what it did, what it is, then the settings and where it sits.
- When it opens with its top out of sight, such as under a tall graph, the page scrolls to its top. Escape or the close button closes it, and the focus goes back to the step's node or row.
- The header holds the status or kind icon, then the step's name and its kind in words on one line, such as "Agent step" or "Shell command".
- What a step is depends on its kind. An agent shows its agent with its description, its prompt with each expression as a chip that selects the step it reads, then its settings, each with where it comes from, the step or the agent. A code step shows its command or source as code, then how it checks, fails and retries. A question shows its words and choices. A breakpoint shows what runs first, then what the person can do. A nested workflow shows its description, inputs and folder. A loop says in a sentence how it repeats.
- Then where the step sits: what runs before it, beside it and after it, what it reads and who reads its answer, and its phase, each as a link that selects that step. Last, a link to its line in the text.
- On a run, what the person can do comes first: the question to answer, or the error and "Resume from here", or "Tell" for a running agent. Then the call's status, times, tokens and cost, its activity, output and result, and the prompt as sent, folded. What the step is comes last. A step that ran more than once switches between its calls with "Call 2 of 3". Five or more tool calls in a row fold into one line. The command as it ran shows only when the run filled something into the step's code.

## The graph

One layout for a run's graph and a saved workflow's graph. A saved graph shows kind icons, a run's graph shows status icons and durations. Reason: the owner asked that the graph show the process at a glance, with arrows for the order and arrows for loops.

Order.

- The graph reads left to right. Every edge ends in an arrowhead at the step it leads to. Edges are 1.5px lines in `--edge`, with rounded elbows and 6px arrowheads.
- A small hollow circle marks the start. A small filled circle marks each way the workflow ends. An early return, such as "the reviewer never approved", leads to its own end mark with its outcome as a label, such as "ends, no commit".
- A condition is a 12px muted label on the edge it guards, such as "approved" or "never approved". There are no condition boxes. The edge out of a `retry` has no label, since sous carries on with the last result once the attempts run out.
- Parallel branches fork from one point and join into one point, with arrows.

Nodes.

- A node is 36px tall with a 1px `--border` and a 6px radius. It holds the icon, the step name, and in a run the duration at the right. Only the icon has color. A node that needs you has a copper border.
- The agent's name shows only when it differs from the step name. The kind is the icon alone, so "sh" and "run" are not written.
- A step with `retries: N` shows a small muted "↻ 2" at the right of its node, with no arrow. In a run that retried, it shows the tries used, such as "↻ 1 of 2". Reason: a retry on failure is not part of the logic the person reads.
- A pipeline over items is one stacked node, drawn as two offset borders, named for what it runs over. In a run it shows "×4" for four items and opens to them.

Loops. sous has two kinds, and both are drawn the same way.

- `gate(work, check, { attempts })` runs the work, then the check, and goes back to the work with the check's feedback until the check passes.
- `retry(work, { attempts, until })` runs the work again until its condition holds.
- A loop is a box around the steps it repeats, with the loop's name at its top left. An arrow goes back from the last step in the box to the first, curving under the box, labeled with the reason and the limit, such as "changes asked ×3". The forward edge out of the box carries the passing condition, such as "approved".
- In a run, the loop's label shows the round it is in, such as "round 2 of 3", and the steps in the box show the latest round.

Groups and size.

- A nested workflow is a box with its name at the top, as GitHub draws a matrix. It folds to one node, which opens on click.
- At 100% the person sees every node. When the columns do not fit the box, nested boxes fold first, then the columns wrap into rows as text does, as the accepted mock does, then the graph turns top to bottom, and scrolling with a visible scroll bar is the last resort.
- The graph opens at 100% and never shrinks below it on open. Zoom and fit buttons sit at the top right of the canvas, where they cover no node. Clicking a node selects it: a 1.5px `--text` border, and its panel under the graph.

## Workflow, agent, skill and MCP pages

All four use one layout, like a Linear issue: the content on the left, the facts on the right. Reason: v3 opened each page with paths and notes, the least useful facts on most visits, and gave every fact the same weight.

The header.

- The breadcrumb, the name as the serif title, and the one-line description in `--text-muted`.
- The primary action at the right of the title. A workflow has Start. The other pages have none, and their actions sit in the "More" menu.
- A banner under the header only when something needs the person or is wrong, such as "Changed since you approved, see what changed" or a check problem. A normal state is not a note: "sous approved this file and nobody changed it" becomes "Approved Nov 4" among the facts.

The two columns.

- When the window is at least 1100px and the page itself at least 800px wide, the content column takes the width, and a details column of 260px sits at its right, with no box and no border, separated by 48px of space. With the list column open, that starts near 1200px. Reason: at 1100px with the list open, the content column would keep only about 400px.
- On a workflow page, the view switch and the graph, Steps or Source span the full page width above the two columns, so the graph can read left to right. Inputs and Last runs sit in the content column beside the details.
- The details column is label and value rows: a 12px muted label above a 13px value. Reason: beside the value, the label leaves about 150px for long paths. Paths are mono and shortened to their file name, with the full path in a tooltip and a copy button.
- Below that width, the details move under the header as a compact block of label and value pairs.

What each page holds.

| Page | Content column | Details column |
| --- | --- | --- |
| Workflow | The graph, with Steps and Source as the other views. Then Inputs, then Last runs. | Lives in, Started by, Works in, Schedule, Timeout, Approved, File, Used by |
| Agent | The prompt, rendered, with Raw. Then Tools, then MCP servers. These three make the agent, so they sit in the content column. | Runs on, Model, Effort, Permission mode, Skills, Used by, File, Other copies |
| Skill | SKILL.md, rendered, with Raw. Its front matter is not repeated in the body. | Copies, one row per harness with a check or "missing", Used by, File |
| MCP server | Connection: type, URL or command, auth with the secret masked and where sous reads it. Then Used by, agents and steps. The raw file folds behind "Show in file". | Seen by, Source, Secrets, File |

- An agent whose settings differ per harness shows one value, and the other harness's value only where it differs, such as the Claude Code model with, under it, "Codex:" and the Codex model. There are no harness tabs.
- Tools are mono tokens. When one harness has a list and the other has every tool, each gets a row. Codex has no tool list, so it says "Every tool".
- MCP servers are one row each: the name links to its page, then the type and its URL or command, then a note when it applies, such as a server only one project has, or one no file defines.
- A hidden duplicate is a row under "Other copies", muted, with "not used".
- Rendered and Raw sit at the top right of every markdown block, in the same place everywhere.

## Search

One search, opened by the Search row in the list column or by `/` from any page. It covers runs, workflows, agents, skills and MCP servers, grouped by kind. Arrow keys move, Enter opens, Escape closes and returns focus. No match says what was searched and where it looked. The rail has no search icon. The scope is a default picked for v4 while the owner's answer is pending.

## Removing things

- A run row shows an x on hover and on focus, next to its age. It removes the run at once and leaves a line in its place that names the run, says "removed" and offers Undo for 8 seconds. On the open run, the page shows the same line.
- A workflow file is never removed by an x. It takes the "More" menu, a dialog that names the path, and a confirm.

## States

Every list, graph and feed has these states, and the mock shows each one through the States list in the mock menu.

- Empty: what is missing and the one command or action that fills it, such as `sous run <workflow>`.
- Loading: rows of the right height in `--skel`, no spinner over the page.
- Error: what failed and what to do, such as "sous serve stopped. Run sous serve again."
- Service down or connection lost: a one-line bar at the top that stays until it comes back.

The full list of states per page is in `states.md` next to this file.

## Motion

Motion shows what changed and where things went, and only that. Nothing animates on scroll and nothing fades in on load. The owner asked for it on 2026-11-25, and on 2026-11-26 for one style across the app that helps without getting in the way. The code is in `src/ui/motion.ts` and under Motion in `src/styles/app.css`.

The system:

- Two curves. What comes, opens, moves or changes eases with `--ease-arrive`, cubic-bezier(0.16, 1, 0.3, 1). What fades away eases with `--ease-leave`, cubic-bezier(0.4, 0, 1, 1).
- Two durations. 200ms, `--base`, to open, arrive, swap or move, either way, since the eye follows a move. 120ms, `--quick`, for what fades away and for feedback. A fade away is faster than the arrival.
- Two longer ones with one job each. 360ms, `--draw`, strokes a status icon or the copy check. 900ms, `--wash`, fades the tint of a step that failed or needs the person.
- One distance. What arrives in place comes 4px, `--rise`. The list column moves its own width, since it comes from the window's edge.
- A `transition` class with no duration takes 120ms on `--ease-arrive`, from Tailwind's defaults, so feedback needs no numbers in the markup. Named animations cover the rest: `animate-arrive`, `animate-arrive-late`, `animate-swap`, `animate-fade-in`, `animate-fade-out`, `animate-wash-fail` and `animate-wash-needs`. Popups share the `POPUP` classes in `motion.ts`.
- Transforms and opacity only, except a fold section's height and the width of a two-way switch's fill, which follows the choice's label. The page never animates its width, since the graph lays out again for each width.

What moves:

- The list column slides out from behind the rail by its width over 200ms and pushes the page right. Closing, it slides back behind the rail and the page follows it. The page takes its new width at once and a transform moves it, so the two stay together. A press during a slide turns it around from where it is. Under 1100px the column opens over the page and slides alone, and its scrim fades in over 200ms and out over 120ms.
- A page switch, such as Runs to a run, plays the new page's arrival: up 4px with a fade over 200ms. The old page goes at once. A view switch, such as Graph to Steps or Source, plays the same arrival on the view. A section switch in the rail plays it on the list column's content too.
- In a two-way switch, such as Graph and Steps, the fill slides to the choice over 200ms.
- A step that changes status while it shows draws its new icon. The check and the X stroke in over 360ms, the dot of "needs you" grows over 200ms, and the running icon fades in as it starts to turn. The graph node, the step row, the runs list row and the header draw it at once. A step that fails or starts needing the person also washes its node and row in that tint, which fades over 900ms.
- The step panel rises 4px with a fade over 200ms as it opens. Another step brightens its name and body from half over 200ms, so the panel never shows empty. Closing fades the panel out and 4px down over 120ms.
- A fold in the graph or in Steps glides the nodes or rows to their new places over 200ms, and new ones fade in 4px from above. In the graph, a frame glides and resizes with its nodes, so an opened box grows out of its folded node. Its name brightens from half and rides the frame's corner from where the folded node was. The labels glide with the nodes, and the edges and marks cross-fade from the old drawing to the new one over the same 200ms.
- A group of the runs list that folds or opens, such as Running or Done, moves like a fold in Steps. A run that changes group slides there over 200ms, above the rows it passes, and a new run fades in. A removed run fades out over 120ms, then the rows below close the gap, or the rows above it when the list is scrolled to its end. A search, a filter or a regroup takes effect at once.
- When the parts around it move down or right to make room, what comes waits 80ms, until they nearly have their places, so they never pass over it. This holds for what comes inside an opened box, the rows of an opened group, and a question or notice.
- A fold section, such as a step's prompt, opens and closes its height over 200ms.
- A new activity line, an answer, and a question or notice that comes while the run shows rise 4px with a fade over 200ms. The views under a question or notice slide to their new place over 200ms as it opens or closes.
- Menus, dropdowns, dialogs, search and tooltips open with a fade over 200ms and fade away over 120ms. A menu or a dropdown comes 4px from its button, and a dialog or search rises 4px. A tooltip only fades, and one that opens while another shows comes at once. A toast rises 4px.
- Feedback takes 120ms: hover fills, color changes and a fold's chevron turning. A pressed button sinks to 97%, a rail button to 94% and a graph node to 98%.
- The copy button draws a check over 360ms and shows it for 1.2s once the copy lands.
- The theme cross-fades over 200ms.
- A running icon's arc turns once per 1.2s. No pulsing dots.
- With `prefers-reduced-motion`, nothing moves, turns or draws. Fades and color changes stay, so each change still shows. The list column fades in and out in place, and the page takes its new width at once. Pages, views, lists, popups and the step panel fade without the 4px. A fold section and an opened group fade in, and close at once. A status icon fades in instead of drawing, and a run that changes group fades in where it went.

## Keyboard

- Tab reaches every control in reading order, and focus shows as a 2px ring in `--text` with 2px offset.
- `/` opens search, ⌘B or Ctrl+B hides the list, Escape closes the top overlay, then the step panel, `g r`, `g w`, `g a`, `g s` and `g m` go to each rail section, `j` and `k` move in the list.
- Scroll boxes are focusable, and each tooltip has a name.

## Copy

- Buttons use sous verbs: Answer, Approve, Send back, Resume, Stop, Tell, Start, Remove. The toast repeats the verb.
- Sentence case everywhere. The product name is lowercase, sous.
- Fake data in the mock is labeled "Sample data", so no one reads it as real.

## Review rules

The reviewer answers each with yes or no, names the width, the element and the rule, and attaches a screenshot.

1. Each page has one first thing to read and one primary action at most.
2. What needs the person is visible from any page in one glance, through the rail badge and the top of the runs list.
3. A status has the same color and the same icon shape in the list row, the step row, the graph node and the header.
4. Color appears only for running, failed and needs you. Everything else is gray.
5. Items in a group sit closer together than the groups do, and space separates sections, not lines.
6. No text is cut off without a fade or an ellipsis and a way to read all of it.
7. Every list, graph and feed shows its empty, loading and error states as a direction.
8. Buttons say what they do in sous words, and the toast uses the same verb.
9. No ALL-CAPS eyebrows, no middle-dot meta strings, no "→" on buttons, no outlined buttons, no fact shown twice in one row or node.
10. The graph shows the order with arrows, each loop with a back arrow and its limit, and what ran, runs, waits and needs the person, without a legend.
11. Tab reaches every control, focus is visible, Escape closes overlays, `/` opens search, ⌘B hides the list.
12. At 375px the page works: the rail and list fold, nothing scrolls sideways, rows are 40px tall.
13. Numbers line up, with tabular figures and one format per unit.
14. Markdown keeps under 80 characters per line and has the Raw switch in the same place.
15. The run page's Steps view reads like the Vercel reference, its Graph view like the GitHub Actions one, and the list column like `paradev-sidebar.png`, when each pair is set side by side. A workflow and its run show the same Graph, the same Steps rows and the same step panel.
16. A workflow, agent, skill or MCP page puts what it does on the left and the facts to look up on the right.
