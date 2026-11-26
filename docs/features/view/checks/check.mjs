#!/usr/bin/env node
// UI check for a single-page HTML mock (hash routed). See README.md.
// Usage: node check.mjs <file-or-url> --out <dir> [--widths 375,768,1440] [--themes light,dark]
//        [--max-routes N] [--routes file.json] [--concurrency N] [--no-shots] [--no-impeccable]

import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const a = { _: [], widths: '375,768,1440', themes: 'light,dark', maxRoutes: 80, shots: true, impeccable: true, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => argv[++i];
    if (x === '--out') a.out = val();
    else if (x === '--widths') a.widths = val();
    else if (x === '--themes') a.themes = val();
    else if (x === '--max-routes') a.maxRoutes = Number(val());
    else if (x === '--routes') a.routes = val();
    else if (x === '--concurrency') a.concurrency = Number(val());
    else if (x === '--no-shots') a.shots = false;
    else if (x === '--no-impeccable') a.impeccable = false;
    else if (x === '--help' || x === '-h') a.help = true;
    else if (x.startsWith('--')) { console.error('Unknown flag ' + x); process.exit(2); }
    else a._.push(x);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (args.help || !args._[0] || !args.out) {
  console.error('Usage: node check.mjs <file-or-url> --out <dir> [--widths 375,768,1440] [--themes light,dark] [--max-routes N] [--routes file.json] [--concurrency N] [--no-shots] [--no-impeccable]');
  process.exit(2);
}
const widths = args.widths.split(',').map((s) => Number(s.trim())).filter(Boolean);
const themes = args.themes.split(',').map((s) => s.trim()).filter(Boolean);
const heightFor = (w) => (w <= 480 ? 812 : w <= 1024 ? 1024 : 900);
const target = args._[0];
const isUrl = /^https?:\/\//i.test(target) || /^file:\/\//i.test(target);
const filePath = isUrl ? null : path.resolve(target);
if (filePath && !fs.existsSync(filePath)) { console.error('No such file: ' + filePath); process.exit(2); }
const baseUrl = (isUrl ? target : pathToFileURL(filePath).href).replace(/#.*$/, '');
const out = path.resolve(args.out);
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });
const log = (...m) => console.error(...m);
const t0 = Date.now();

// ---------------------------------------------------------------- helpers
const slugOf = (route) => {
  const s = route.replace(/^#\/?/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) return 'root';
  if (s.length <= 80) return s;
  let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return s.slice(0, 70) + '-' + h.toString(36);
};
const normRoute = (r) => {
  if (r == null) return null;
  r = String(r).trim();
  if (!r || r === '#' || r === '#/' ) return null;
  if (/\s/.test(r) || /^[a-z][a-z0-9+.-]*:/i.test(r)) return null;
  if (r.startsWith('#')) return r;
  return '#/' + r.replace(/^\/+/, '');
};
const routeUrl = (route) => baseUrl + (route && route !== '#' ? route : '');

async function settle(page) {
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
    null, { timeout: 2500 }
  ).catch(() => {});
  await page.waitForTimeout(200);
}

const CLEAR_STORAGE = () => {
  // Make the emulated color scheme win over a stored theme choice.
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
};

async function newContext(browser, width, theme) {
  const ctx = await browser.newContext({
    viewport: { width, height: heightFor(width) },
    colorScheme: theme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  await ctx.addInitScript(CLEAR_STORAGE);
  return ctx;
}

function attachErrorCollector(page, sink, getRoute) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url || '';
    if (/favicon\.ico$/.test(loc)) return;
    sink.push({ route: getRoute(), text: m.text().slice(0, 400), source: loc ? loc.slice(0, 120) : undefined });
  });
  page.on('pageerror', (e) => sink.push({ route: getRoute(), text: ('Uncaught: ' + (e.message || e)).slice(0, 400) }));
}

// ---------------------------------------------------------------- in-page code
// Runs inside the page. Must stay self-contained.
function pageLayoutChecks() {
  const sel = (el) => {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && parts.length < 4) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(s + '#' + CSS.escape(e.id)); break; }
      s += [...e.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === e.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      }
      parts.unshift(s);
      e = e.parentElement;
    }
    return parts.join(' > ');
  };
  const txt = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const clipped = new Map();
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    if (r.width <= 1 && r.height <= 1) return null; // visually hidden helpers
    if (r.right <= 0 || r.bottom <= 0) return null; // parked off-screen
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    // Clip to every overflow ancestor. Fully clipped means not visible right now
    // (a closed drawer, or a node scrolled out of a graph).
    let L = r.left, T = r.top, R = r.right, B = r.bottom;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const ar = a.getBoundingClientRect();
        L = Math.max(L, ar.left); T = Math.max(T, ar.top); R = Math.min(R, ar.right); B = Math.min(B, ar.bottom);
        if (R <= L || B <= T) return null;
      }
    }
    clipped.set(el, { left: L, top: T, right: R, bottom: B });
    return r;
  };
  const res = { hscroll: null, scrollers: [], cutoff: [], overlap: [], small: [] };

  // 2. Horizontal page scroll
  const de = document.documentElement;
  if (de.scrollWidth > innerWidth + 1) {
    const offenders = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = visibleRect(el);
      if (r && r.right > innerWidth + 1) offenders.push({ sel: sel(el), right: Math.round(r.right) });
      if (offenders.length >= 40) break;
    }
    // Keep the innermost-looking, widest few.
    offenders.sort((a, b) => b.right - a.right);
    res.hscroll = { scrollWidth: de.scrollWidth, innerWidth, offenders: offenders.slice(0, 3).map((o) => o.sel) };
  }

  // 2b. Sideways overflow inside a wide scrolling container
  // (the page itself may never scroll when the shell scrolls inside a container).
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg')) continue;
    if (el.closest('[data-scroll-x]')) continue; // marked as a sideways scroller on purpose
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const cs = getComputedStyle(el);
    if (!/^(auto|scroll|hidden|clip)$/.test(cs.overflowX)) continue;
    if (cs.textOverflow === 'ellipsis') continue; // truncated text with an ellipsis is intended
    const r = visibleRect(el);
    if (!r || r.width < 0.4 * innerWidth) continue;
    const box = el.getBoundingClientRect();
    const pick = (list) => {
      let best = null;
      for (const c of list) {
        const cr = c.getBoundingClientRect();
        if (cr.width <= 0 || cr.right <= box.right + 1) continue;
        if (!best || cr.width > best.w) best = { el: c, w: cr.width };
      }
      return best;
    };
    const w = pick(el.children) || pick(el.querySelectorAll('*'));
    res.scrollers.push({
      sel: sel(el), overflowX: cs.overflowX, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      widest: w ? sel(w.el) : null, widestWidth: w ? Math.round(w.w) : null,
    });
    if (res.scrollers.length >= 30) break;
  }

  // 3. Cut-off text
  const clips = (v) => v === 'hidden' || v === 'clip';
  const cand = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const cs = getComputedStyle(el);
    if (!clips(cs.overflowX) && !clips(cs.overflowY)) continue;
    if (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) continue;
    if (cs.textOverflow === 'ellipsis' || el.hasAttribute('title')) continue;
    const clamp = cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp');
    if (clamp && clamp !== 'none') continue;
    const r = visibleRect(el);
    if (!r) continue;
    // Is there text that really sticks out of the box?
    const box = el.getBoundingClientRect();
    let cut = false;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const rng = document.createRange();
    for (let n = tw.nextNode(); n && !cut; n = tw.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      rng.selectNodeContents(n);
      for (const tr of rng.getClientRects()) {
        if (tr.width === 0 || tr.height === 0) continue;
        if ((clips(cs.overflowX) && (tr.right > box.right + 1 || tr.left < box.left - 1)) ||
            (clips(cs.overflowY) && (tr.bottom > box.bottom + 1 || tr.top < box.top - 1))) { cut = true; break; }
      }
    }
    if (cut) cand.push(el);
  }
  // Keep the innermost element only.
  for (const el of cand) {
    if (cand.some((o) => o !== el && el.contains(o))) continue;
    res.cutoff.push({ sel: sel(el), text: txt(el) });
    if (res.cutoff.length >= 30) break;
  }

  // 4 + 5. Controls
  const controls = [];
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]')) {
    const r = visibleRect(el);
    if (r) controls.push({ el, r: clipped.get(el) || r, full: r });
    if (controls.length >= 2000) break;
  }
  const over = new Set();
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox > 4 && oy > 4) {
        const k = sel(a.el) + ' | ' + sel(b.el);
        if (over.has(k)) continue;
        over.add(k);
        res.overlap.push({ a: sel(a.el), b: sel(b.el), aText: txt(a.el), bText: txt(b.el), px: Math.round(Math.min(ox, oy)) });
      }
    }
    if (res.overlap.length >= 30) break;
  }
  for (const { el, full: r } of controls) {
    const w = Math.round(r.width * 10) / 10, h = Math.round(r.height * 10) / 10;
    if (w >= 24 && h >= 24) continue;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') {
      // Inline link inside a sentence is exempt (WCAG 2.5.8).
      const p = el.parentElement;
      const own = p ? [...p.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 2) : false;
      if (own) continue;
    }
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type) && el.labels && el.labels.length) {
      // Native box with a label: the label is the target if it is big enough.
      const lr = el.labels[0].getBoundingClientRect();
      if (lr.width >= 24 && lr.height >= 24) continue;
    }
    res.small.push({ sel: sel(el), text: txt(el), w: Math.round(w), h: Math.round(h) });
    if (res.small.length >= 60) break;
  }
  return res;
}

function pageLinks() {
  const out = [];
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    const h = a.getAttribute('href');
    if (!h || h === '#') continue;
    const id = decodeURIComponent(h.slice(1));
    if (id && !id.startsWith('/') && document.getElementById(id)) continue; // in-page anchor
    out.push(h);
  }
  for (const el of document.querySelectorAll('[data-route],[data-go],[data-href],[data-to],[data-link],[data-path],[data-navigate]')) {
    for (const k of ['route', 'go', 'href', 'to', 'link', 'path', 'navigate']) {
      const v = el.dataset[k];
      if (v) out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------- crawl
async function crawl(browser) {
  const sink = [];
  const ctx = await newContext(browser, 1440, 'light');
  const page = await ctx.newPage();
  let current = '(start)';
  attachErrorCollector(page, sink, () => current);
  await page.goto(baseUrl, { waitUntil: 'load' });
  await settle(page);

  const finalOf = async () => (await page.evaluate(() => location.hash)) || '';
  const visited = new Map(); // final hash -> true
  const queue = [];
  const queued = new Set();
  const push = (r) => { const n = normRoute(r); if (n && !queued.has(n)) { queued.add(n); queue.push(n); } };

  const start = (await finalOf()) || '#';
  visited.set(start, true);
  queued.add(start);
  for (const l of await page.evaluate(pageLinks)) push(l);

  while (queue.length && visited.size < args.maxRoutes) {
    const next = queue.shift();
    current = next;
    await page.evaluate((h) => { location.hash = h; }, next);
    await settle(page);
    const fin = (await finalOf()) || next;
    if (visited.has(fin)) continue;
    visited.set(fin, true);
    queued.add(fin);
    for (const l of await page.evaluate(pageLinks)) push(l);
  }
  const truncated = queue.some((q) => !visited.has(q));
  await ctx.close();
  return { routes: [...visited.keys()], routeChangeErrors: sink, truncated, unvisited: queue.filter((q) => !visited.has(q)).length };
}

// ---------------------------------------------------------------- per-route checks
async function checkOne(browser, route, width, theme, findings) {
  const base = { route, width, theme };
  const add = (check, severity, detail) => findings.push({ check, severity, ...base, ...detail });
  const ctx = await newContext(browser, width, theme);
  const page = await ctx.newPage();
  const errs = [];
  attachErrorCollector(page, errs, () => route);
  try {
    await page.goto(routeUrl(route), { waitUntil: 'load', timeout: 20000 });
    await settle(page);

    // Make sure the emulated scheme took effect.
    const scheme = await page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    if (scheme !== theme) add('load', 'failure', { message: `Emulated color scheme did not apply (got ${scheme}).` });

    // 1 + 7. axe
    await page.addScriptTag({ path: AXE_PATH });
    const ax = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }, resultTypes: ['violations', 'incomplete'] });
      const pick = (v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')), msg: v.nodes[0] && (v.nodes[0].any[0]?.message || v.nodes[0].all[0]?.message || v.nodes[0].none[0]?.message || '') });
      return { violations: r.violations.map(pick), incomplete: r.incomplete.filter((v) => v.id === 'color-contrast').map(pick) };
    });
    for (const v of ax.violations) {
      add('axe', v.impact === 'serious' || v.impact === 'critical' ? 'failure' : 'warning', { id: v.id, impact: v.impact, help: v.help, nodes: v.nodes, targets: v.targets });
    }
    for (const v of ax.incomplete) {
      add('contrast-incomplete', 'warning', { id: v.id, help: v.help, nodes: v.nodes, targets: v.targets, message: (v.msg || '').slice(0, 200) });
    }

    // 2-5. layout checks
    const L = await page.evaluate(pageLayoutChecks);
    if (L.hscroll) add('hscroll', 'failure', { scrollWidth: L.hscroll.scrollWidth, innerWidth: L.hscroll.innerWidth, offenders: L.hscroll.offenders });
    for (const c of L.scrollers) add('container-overflow', 'failure', { selector: c.sel, overflowX: c.overflowX, scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, widest: c.widest, widestWidth: c.widestWidth });
    for (const c of L.cutoff) add('cutoff-text', 'warning', { selector: c.sel, text: c.text });
    for (const o of L.overlap) add('overlap', 'warning', { selector: o.a, other: o.b, text: o.aText, otherText: o.bText, px: o.px });
    for (const s of L.small) add('small-target', 'warning', { selector: s.sel, text: s.text, size: `${s.w}x${s.h}` });

    // 8. screenshots (one visit per route, width and theme, so this is always the first)
    if (args.shots) {
      const name = `${slugOf(route)}__${width}__${theme}`;
      await page.screenshot({ path: path.join(out, 'shots', name + '.png') });
      const tall = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1);
      if (tall) await page.screenshot({ path: path.join(out, 'shots', name + '__full.png'), fullPage: true });
    }
  } catch (e) {
    add('load', 'failure', { message: String(e.message || e).split('\n')[0].slice(0, 300) });
  }
  // 6. console errors during load
  for (const e of errs) add('console', 'failure', { message: e.text, source: e.source });
  await ctx.close();
}

// ---------------------------------------------------------------- impeccable
function runImpeccable() {
  const dest = path.join(out, 'impeccable.txt');
  if (!args.impeccable) return { status: 'skipped', reason: '--no-impeccable' };
  const tgt = filePath || target;
  const r = spawnSync('npx', ['--offline', '--yes', 'impeccable@4.5.2', 'detect', tgt], { encoding: 'utf8', timeout: 180000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  const text = [(r.stdout || ''), (r.stderr || '')].filter(Boolean).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  if (r.error || r.status === 1 || r.status === null) {
    const reason = r.error ? String(r.error.message) : `exit ${r.status}: ${text.split('\n').slice(0, 3).join(' ').slice(0, 200)}`;
    fs.writeFileSync(dest, `impeccable detect was skipped or failed: ${reason}\n\n${text}`);
    return { status: 'skipped', reason };
  }
  fs.writeFileSync(dest, text);
  return { status: r.status === 0 ? 'clean' : 'findings', exit: r.status, text };
}

// ---------------------------------------------------------------- main
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let routes, crawlInfo = { source: 'crawl' };
let routeChangeErrors = [];
if (args.routes) {
  const j = JSON.parse(fs.readFileSync(args.routes, 'utf8'));
  routes = (Array.isArray(j) ? j : j.routes).map(normRoute).filter(Boolean);
  crawlInfo = { source: 'file', file: args.routes };
} else {
  log('Crawling routes...');
  const c = await crawl(browser);
  routes = c.routes; routeChangeErrors = c.routeChangeErrors;
  crawlInfo = { source: 'crawl', truncated: c.truncated, unvisited: c.unvisited };
}
routes = [...new Set(routes)];
log(`${routes.length} routes, ${widths.length} widths, ${themes.length} themes = ${routes.length * widths.length * themes.length} runs (${((Date.now() - t0) / 1000).toFixed(1)}s so far)`);

const tasks = [];
for (const route of routes) for (const width of widths) for (const theme of themes) tasks.push({ route, width, theme });
const findings = [];
let done = 0;
await pool(tasks, args.concurrency, async (t) => {
  await checkOne(browser, t.route, t.width, t.theme, findings);
  done++;
  if (done % 20 === 0 || done === tasks.length) log(`  ${done}/${tasks.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
});
await browser.close();

// route-change console errors from the crawl
for (const e of routeChangeErrors) findings.push({ check: 'console', severity: 'failure', route: e.route, width: 1440, theme: 'light', message: e.text, source: e.source, phase: 'route-change' });

const imp = runImpeccable();

// ---------------------------------------------------------------- report
const flat = (x) => String(x || '').replace(/:nth-of-type\(\d+\)/g, '');
const keyOf = (f) => {
  switch (f.check) {
    case 'axe': return `axe|${f.id}|${f.impact}`;
    case 'contrast-incomplete': return `ci|${f.id}`;
    case 'hscroll': return `hs|${f.offenders.join(',')}`;
    case 'container-overflow': return `cs|${flat(f.selector)}`;
    case 'console': return `co|${f.message}`;
    case 'cutoff-text': return `cut|${flat(f.selector)}`;
    case 'overlap': return `ov|${flat(f.selector)}|${flat(f.other)}`;
    case 'small-target': return `sm|${flat(f.selector)}`;
    default: return `${f.check}|${f.message || ''}`;
  }
};
const order = ['axe', 'hscroll', 'container-overflow', 'console', 'load', 'cutoff-text', 'overlap', 'small-target', 'contrast-incomplete'];
const labels = {
  axe: 'axe-core (WCAG A, AA, 2.1 AA)', hscroll: 'Horizontal page scroll', 'container-overflow': 'Sideways overflow in scroll containers', console: 'Console and page errors', load: 'Load errors',
  'cutoff-text': 'Cut-off text', overlap: 'Overlapping controls', 'small-target': 'Targets under 24x24 px', 'contrast-incomplete': 'Contrast axe could not decide',
};
const sev = (f) => (f.severity === 'failure' ? 0 : 1);
const impactRank = { critical: 0, serious: 1, moderate: 2, minor: 3 };

const groups = new Map();
for (const f of findings) {
  const k = keyOf(f);
  let g = groups.get(k);
  if (!g) { g = { key: k, check: f.check, severity: f.severity, sample: f, routes: new Set(), widths: new Set(), themes: new Set(), count: 0 }; groups.set(k, g); }
  if ((f.nodes || 0) > (g.sample.nodes || 0)) g.sample = f;
  g.routes.add(f.route); g.widths.add(f.width); g.themes.add(f.theme); g.count++;
}
const G = [...groups.values()];
const rank = (g) => [sev(g.sample), g.check === 'axe' ? (impactRank[g.sample.impact] ?? 4) : order.indexOf(g.check) + 1, -g.routes.size * g.widths.size * g.themes.size];
G.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return 0; });

const failures = findings.filter((f) => f.severity === 'failure');
const warnings = findings.filter((f) => f.severity === 'warning');
const byCheck = {};
for (const c of order) {
  const fs_ = findings.filter((f) => f.check === c);
  byCheck[c] = { raw: fs_.length, unique: G.filter((g) => g.check === c).length, failures: fs_.filter((f) => f.severity === 'failure').length, warnings: fs_.filter((f) => f.severity === 'warning').length };
}
const pass = failures.length === 0;
const elapsed = (Date.now() - t0) / 1000;

const meta = {
  target, baseUrl, out, widths, themes, maxRoutes: args.maxRoutes, routes: routes.length, runs: tasks.length, elapsedSeconds: Math.round(elapsed),
  crawl: crawlInfo, impeccable: { status: imp.status, reason: imp.reason, exit: imp.exit }, date: new Date().toISOString(),
};
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({
  pass, meta, routes,
  totals: { failures: failures.length, warnings: warnings.length, uniqueFindings: G.length, byCheck },
  groups: G.map((g) => ({ check: g.check, severity: g.severity, occurrences: g.count, routes: [...g.routes], widths: [...g.widths].sort((a, b) => a - b), themes: [...g.themes], example: g.sample })),
  findings,
}, null, 1));

const detail = (g) => {
  const f = g.sample;
  switch (g.check) {
    case 'axe': return `${f.id} (${f.impact}): ${f.help}. Targets: ${f.targets.map((t) => '`' + t + '`').join(', ')}${f.nodes > f.targets.length ? ` (${f.nodes} nodes on the worst page)` : ''}`;
    case 'contrast-incomplete': return `${f.help}. Check by eye. Targets: ${f.targets.map((t) => '`' + t + '`').join(', ')}${f.message ? ' (' + f.message + ')' : ''}`;
    case 'hscroll': return `Page scrolls sideways (scrollWidth ${f.scrollWidth} vs width ${f.innerWidth}). Widest: ${f.offenders.map((t) => '`' + t + '`').join(', ') || 'unknown'}`;
    case 'container-overflow': return `\`${f.selector}\` (overflow-x ${f.overflowX}) holds ${f.scrollWidth} px in ${f.clientWidth} px. Widest child sticking out: ${f.widest ? '`' + f.widest + '` (' + f.widestWidth + ' px)' : 'none found'}`;
    case 'console': return `${f.message}${f.phase ? ' (during route change)' : ''}`;
    case 'cutoff-text': return `\`${f.selector}\` cuts off "${f.text}"`;
    case 'overlap': return `\`${f.selector}\` ("${f.text}") overlaps \`${f.other}\` ("${f.otherText}") by ${f.px} px`;
    case 'small-target': return `\`${f.selector}\` "${f.text}" is ${f.size}`;
    default: return f.message || '';
  }
};
const where = (g) => {
  const r = [...g.routes];
  const rs = r.length <= 3 ? r.join(', ') : `${r.slice(0, 3).join(', ')} and ${r.length - 3} more`;
  return `${r.length} route${r.length > 1 ? 's' : ''} (${rs}); widths ${[...g.widths].sort((a, b) => a - b).join(', ')}; themes ${[...g.themes].join(', ')}`;
};

const md = [];
md.push(`# UI check: ${pass ? 'PASS' : 'FAIL'}`);
md.push('');
md.push(`${path.basename(target)}: ${routes.length} routes, widths ${widths.join(', ')}, themes ${themes.join(', ')}. ${failures.length} failures, ${warnings.length} warnings (${G.length} unique after merging widths, themes and routes). Took ${Math.round(elapsed)}s.`);
md.push('');
md.push('## Top 10 findings');
md.push('');
if (!G.length) md.push('None.');
G.slice(0, 10).forEach((g, i) => md.push(`${i + 1}. [${g.severity}] ${detail(g)}. Seen on ${where(g)}.`));
md.push('');
md.push('## Totals');
md.push('');
md.push('| Check | Failures | Warnings | Unique findings |');
md.push('| --- | ---: | ---: | ---: |');
for (const c of order) md.push(`| ${labels[c]} | ${byCheck[c].failures} | ${byCheck[c].warnings} | ${byCheck[c].unique} |`);
md.push(`| Total | ${failures.length} | ${warnings.length} | ${G.length} |`);
md.push('');
md.push('Failures are axe serious or critical, horizontal page scroll, sideways overflow in a wide scroll container (unless marked `data-scroll-x`), console errors and load errors. Everything else is a warning.');
md.push('');
if (crawlInfo.source === 'crawl' && crawlInfo.truncated) md.push(`The crawl stopped at ${args.maxRoutes} routes with about ${crawlInfo.unvisited} links not visited. Raise --max-routes to see them.\n`);
md.push(`Impeccable: ${imp.status === 'skipped' ? 'skipped (' + imp.reason + ')' : imp.status === 'clean' ? 'no findings' : 'findings in impeccable.txt'}.`);
md.push('');
for (const c of order) {
  const gs = G.filter((g) => g.check === c);
  if (!gs.length) continue;
  md.push(`## ${labels[c]}`);
  md.push('');
  for (const g of gs) md.push(`- [${g.severity}] ${detail(g)}. ${where(g)}.`);
  md.push('');
}
if (imp.text) { md.push('## Impeccable detect'); md.push(''); md.push('```'); md.push(imp.text.trim().split('\n').slice(0, 40).join('\n')); md.push('```'); md.push(''); }
md.push('## Routes checked');
md.push('');
md.push(routes.map((r) => '`' + r + '`').join(', '));
md.push('');
fs.writeFileSync(path.join(out, 'report.md'), md.join('\n'));

log(`${pass ? 'PASS' : 'FAIL'}: ${failures.length} failures, ${warnings.length} warnings, ${routes.length} routes, ${Math.round(elapsed)}s. Report: ${path.join(out, 'report.md')}`);
process.exit(pass ? 0 : 1);
