// Screenshots of view routes, for a design review. Start the page first with `pnpm dev` or
// `pnpm build && pnpm preview`, then:
//
//   node scripts/shot.mjs <out dir> <width> <light|dark> <route> [<route> ...]
//   node scripts/shot.mjs shots 1440 dark /kit /runs/r-1?view=steps
//
// A route ends with "@full" for the whole page. Only `pnpm dev` has /kit. BASE sets the page's address, which defaults to
// the dev server. It uses the installed Google Chrome, so it downloads no browser.

import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [out, width, theme, ...routes] = process.argv.slice(2);
if (!out || !width || !theme || !routes.length) {
  console.error("Usage: node scripts/shot.mjs <out dir> <width> <light|dark> <route> [<route> ...]");
  process.exit(2);
}
const base = process.env.BASE ?? "http://localhost:5199/";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

for (const [i, raw] of routes.entries()) {
  const full = raw.endsWith("@full");
  const route = full ? raw.slice(0, -5) : raw;
  // The live stream keeps a request open, so the network is never idle. The page's reads end
  // well within the pause.
  await page.goto(`${base}#${route}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  const file = join(out, `${String(i + 1).padStart(2, "0")}-${route.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root"}-${width}${theme[0]}.png`);
  if (full) {
    const height = await page.evaluate(() => document.querySelector("#main")?.scrollHeight ?? 900);
    await page.setViewportSize({ width: Number(width), height: Math.min(6000, Math.max(900, height)) });
  }
  await page.screenshot({ path: file });
  if (full) await page.setViewportSize({ width: Number(width), height: 900 });
  console.log(file);
}
await browser.close();
if (errors.length) {
  console.error(`Console errors:\n${errors.join("\n")}`);
  process.exit(1);
}
