# UI/UX design flow for the sous view

How the view's pages get designed and improved. Agreed with the owner on 2026-11-24, from four research passes on agent UI work. It is for the sous view only, not for the agent-workflow skills.

## What the research says

- A model is a poor judge of UI quality on its own. Asked which of two UIs is better, it agrees with people about 70% of the time (WebDevJudge, https://arxiv.org/abs/2510.18560). It is near chance on ease of use (https://arxiv.org/abs/2510.08783), and it misses most of the usability issues experts find (https://arxiv.org/abs/2506.16345). It does best with yes/no rules, code plus screenshots, and a reference to compare against.
- The best-supported loop: render, look at screenshots, critique, fix. One study measured up to 17.8% better output over three rounds of this loop (https://iclr.cc/virtual/2026/10018663). Nothing shows gains after three.
- Good output comes from real copy and facts, a reference that sets the bar, a short rules file, and every state shown.
- The owner judges taste and whether a page is easy to use. Agents find problems and fix them.

## The flow

1. **References.** Gather 3 to 5 screens from Paradev and similar developer tools. The owner picks which ones set the bar. Save them in `docs/features/view/references/`.
2. **DESIGN.md.** One short file in `docs/features/view/` with colors, type, spacing and density, and a reason for each rule.
   - The look comes from `minimalist-ui` only. Charts use `dataviz`. The plan-then-critique steps come from Anthropic's `frontend-design`.
   - Leave the other style skills out, since they conflict: design-taste v1 and v2, high-end-visual-design, gpt-taste, stitch-design-taste and industrial-brutalist-ui.
3. **Every state.** Each page shows its loading, empty, error, long-text and many-items states, such as 200 runs, a failed run and very long names.
4. **Check loop, three rounds at most.** Each round fixes two or three things.
   - Scripts first, through the Chrome DevTools MCP tools:
     - axe-core, WCAG A and AA;
     - no sideways scroll and no cut-off text at 375, 768 and 1440 px;
     - no console errors;
     - text contrast of at least 4.5:1;
     - optionally `npx impeccable detect`, which runs 62 rules for AI-UI tells.
   - Then a fresh-context reviewer checks yes/no rules from DESIGN.md. It compares against the references and the last accepted version, and runs each comparison twice with the order swapped. Every finding names the width, the element and the rule, with a screenshot.
   - Never pass or fail a page on a model's score.
5. **Owner review.** Screenshots at the three widths and a keyboard-only pass: tab through every control, check that focus is visible and that Escape closes dialogs. What the owner accepts becomes the baseline that later changes are compared against.

## Common AI-UI failures, and the step that prevents each

- **The generic look** (Inter, a purple gradient, a centered hero, three icon cards, unchanged shadcn): prevented by references and DESIGN.md.
- **Only the happy path built:** prevented by every state.
- **Breaks on narrow screens or with long content:** prevented by the width checks.
- **Invented copy or facts:** prevented by real copy and the fake-data label.
- **"Done" without looking:** prevented by screenshots as evidence.
- **A fix that breaks earlier work:** prevented by small batches and before-and-after screenshots.

## Sources worth rereading

- Anthropic frontend-design skill: https://github.com/anthropics/skills/tree/main/skills/frontend-design
- Impeccable (critique, audit and detect): https://github.com/pbakaus/impeccable
- OneRedOak design-review subagent (checks at three widths): https://github.com/OneRedOak/claude-code-workflows/tree/main/design-review
- Vercel web interface guidelines: https://vercel.com/design/guidelines
- Vercel, teaching agents product design: https://vercel.com/blog/teaching-agents-product-design-at-vercel
- UICrit, where critique with example screens was 55% better: https://arxiv.org/abs/2407.08850
- Playwright accessibility testing with axe: https://playwright.dev/docs/accessibility-testing
