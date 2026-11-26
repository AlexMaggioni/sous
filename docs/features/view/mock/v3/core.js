/* sous view mock v3: helpers, icons, formats, markdown, router, rail, list column, search, toast, states menu. */
"use strict";

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const enc = encodeURIComponent;
const store = {
  get(k, f) { try { const v = localStorage.getItem("sous-mock-v3-" + k); return v == null ? f : JSON.parse(v); } catch (e) { return f; } },
  set(k, v) { try { localStorage.setItem("sous-mock-v3-" + k, JSON.stringify(v)); } catch (e) { /* storage may be off */ } },
};

/* ------------------------------------------------------------------ formats, one per unit */
const fmtDur = (ms) => {
  if (ms == null || isNaN(ms)) return "";
  if (ms < 1000) return Math.max(0, Math.round(ms)) + "ms";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + "m " + String(r).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  return h + "h " + String(m % 60).padStart(2, "0") + "m";
};
const fmtTok = (n) => n == null ? "" : n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : (n / 1e6).toFixed(2) + "M";
const fmtCost = (c) => c == null ? "" : "$" + c.toFixed(2);
const pad2 = (n) => String(n).padStart(2, "0");
const fmtClock = (t) => { const d = new Date(t); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
const fmtClockS = (t) => { const d = new Date(t); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); };
const fmtDate = (t) => new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" });
const fmtFull = (t) => new Date(t).toLocaleString("en", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const fmtAgo = (t) => {
  const d = Date.now() - t;
  if (d < -45 * SEC) return -d < HR ? "in " + Math.round(-d / MIN) + "m" : -d < DAY ? "in " + Math.round(-d / HR) + "h" : fmtDate(t);
  if (d < 45 * SEC) return "just now";
  if (d < HR) return Math.round(d / MIN) + "m ago";
  if (d < DAY) return Math.round(d / HR) + "h ago";
  return fmtDate(t);
};
const fmtAge = (t) => {
  const d = Date.now() - t;
  if (d < 45 * SEC) return "now";
  if (d < HR) return Math.round(d / MIN) + "m";
  if (d < DAY) return Math.round(d / HR) + "h";
  return fmtDate(t);
};
/* One rule for a point in time: relative under a day, the full date and time in a tooltip. The tick keeps the text current. */
const timeEl = (t, o) => '<time datetime="' + new Date(t).toISOString() + '" data-ago="' + t + '" data-tip="' + esc(fmtFull(t)) + '"' + (o && o.quiet ? "" : ' tabindex="0"') + ">" + esc(fmtAgo(t)) + "</time>";
const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));

/* ------------------------------------------------------------------ icons */
const sv = (d, sw) => '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.6) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
const I = {
  runs: sv('<circle cx="10" cy="10" r="7.2"/><path d="M8.6 7.3v5.4l4.2-2.7z" fill="currentColor"/>'),
  workflows: sv('<rect x="2.8" y="3" width="5.4" height="5.4" rx="1.3"/><rect x="11.8" y="11.6" width="5.4" height="5.4" rx="1.3"/><path d="M5.5 8.4v3a2.4 2.4 0 0 0 2.4 2.4h3.9"/>'),
  agents: sv('<rect x="3.8" y="6" width="12.4" height="10" rx="3"/><path d="M10 6V3.4"/><circle cx="7.8" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="12.2" cy="11" r="1" fill="currentColor" stroke="none"/>'),
  skills: sv('<path d="M4 4.6A1.6 1.6 0 0 1 5.6 3h9.9v12H5.6A1.6 1.6 0 0 0 4 16.6z"/><path d="M4 16.6A1.4 1.4 0 0 0 5.4 18h10.1v-3"/><path d="M7.6 7h4.6M7.6 9.8h3"/>'),
  mcp: sv('<path d="M7 2.8v3.6M13 2.8v3.6"/><path d="M4.8 6.4h10.4v3a5.2 5.2 0 0 1-10.4 0z"/><path d="M10 14.6v2.6"/>'),
  search: sv('<circle cx="8.8" cy="8.8" r="5.3"/><path d="m12.8 12.8 3.7 3.7"/>'),
  x: sv('<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>', 1.8),
  chev: sv('<path d="m7.5 5 5 5-5 5"/>', 1.8),
  chevD: sv('<path d="m5 7.5 5 5 5-5"/>', 1.8),
  sun: sv('<circle cx="10" cy="10" r="3.3"/><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7 6 6M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3"/>'),
  moon: sv('<path d="M15.6 12.4A6.5 6.5 0 0 1 7.6 4.4a6.6 6.6 0 1 0 8 8z"/>'),
  auto: sv('<circle cx="10" cy="10" r="6.6"/><path d="M10 3.4v13.2a6.6 6.6 0 0 0 0-13.2z" fill="currentColor"/>'),
  stop: sv('<rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/>'),
  play: sv('<path d="M6.5 4.5v11l8.5-5.5z"/>'),
  pause: sv('<path d="M7.5 5v10M12.5 5v10"/>', 2),
  tell: sv('<path d="M3 4h14v9H9.5L5.6 16v-3H3z"/>'),
  file: sv('<path d="M5 2.8h6.6l3.6 3.6v10.8H5z"/><path d="M11.4 2.8v3.8h3.8"/>'),
  warn: sv('<path d="M10 3 17.6 16.2H2.4z"/><path d="M10 8.2v3.6M10 14v.1"/>'),
  ok: sv('<path d="m4.5 10.5 3.6 3.6 7.4-7.9"/>', 1.8),
  info: sv('<circle cx="10" cy="10" r="7.2"/><path d="M10 9.2v4.4M10 6.4v.1"/>'),
  term: sv('<rect x="2.6" y="3.6" width="14.8" height="12.8" rx="2.4"/><path d="m6.2 8 2.4 2.1-2.4 2.1M10.6 12.6h3.2"/>'),
  code: sv('<path d="M7 5.8 2.8 10 7 14.2M13 5.8l4.2 4.2-4.2 4.2"/>'),
  ask: sv('<path d="M3 4h14v9.4H9.6l-4 3.2v-3.2H3z"/><path d="M8.4 7.4a1.7 1.7 0 1 1 2.4 1.6c-.5.2-.8.6-.8 1.1v.2M10 12v.1"/>'),
  inbox: sv('<path d="M2.8 11.4 4.9 4.2h10.2l2.1 7.2v4.4H2.8z"/><path d="M2.8 11.4h4.1l1.1 2h4l1.1-2h4.1"/>'),
  fork: sv('<circle cx="5.2" cy="4.6" r="1.9"/><circle cx="5.2" cy="15.4" r="1.9"/><circle cx="14.8" cy="8" r="1.9"/><path d="M5.2 6.5v7M5.2 11.6c0-2.4 1.8-3.6 4.4-3.6h3.3"/>'),
  loop: sv('<path d="M15.6 8.2A6 6 0 0 0 4.8 6.4M4.4 11.8a6 6 0 0 0 10.8 1.8"/><path d="M4.4 3.4v3.2h3.2M15.6 16.6v-3.2h-3.2"/>'),
  gate: sv('<path d="M4 3v14M16 3v14M4 7h12M4 13h12"/>'),
  bp: sv('<path d="M7 2.8h6l4.2 4.2v6L13 17.2H7L2.8 13V7z"/><path d="M8.3 7.6v4.8M11.7 7.6v4.8"/>'),
  par: sv('<path d="M3 10h3M6 10c2 0 2-5 4.5-5H17M6 10c2 0 2 5 4.5 5H17M10 10h7"/>'),
  pipe: sv('<path d="M3 6h14M3 14h14"/><circle cx="7" cy="6" r="1.6"/><circle cx="13" cy="14" r="1.6"/>'),
  lane: sv('<path d="M3 10h14"/><circle cx="10" cy="10" r="2"/>'),
  clock: sv('<circle cx="10" cy="10" r="7.2"/><path d="M10 6.2V10l2.6 1.8"/>'),
  copy: sv('<rect x="7" y="7" width="9.5" height="9.5" rx="1.8"/><path d="M13 7V5.3A1.8 1.8 0 0 0 11.2 3.5H5.3A1.8 1.8 0 0 0 3.5 5.3v5.9A1.8 1.8 0 0 0 5.3 13H7"/>'),
  more: sv('<circle cx="5" cy="10" r="1.2" fill="currentColor"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/><circle cx="15" cy="10" r="1.2" fill="currentColor"/>'),
  list: sv('<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"/>'),
  states: sv('<path d="M10 3 17 6.5 10 10 3 6.5z"/><path d="m3 10 7 3.5 7-3.5M3 13.5 10 17l7-3.5"/>'),
  gear: sv('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M4.8 15.2l1.4-1.4M13.8 6.2l1.4-1.4"/>'),
  plus: sv('<path d="M10 4.5v11M4.5 10h11"/>', 1.8),
  minus: sv('<path d="M4.5 10h11"/>', 1.8),
  fit: sv('<path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/>'),
  back: sv('<path d="M8 5 4 9l4 4"/><path d="M4.5 9H12a4 4 0 0 1 0 8h-1.5"/>'),
  trash: sv('<path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10.5h7.4L14.5 6"/>'),
  read: sv('<path d="M3 5h5a2 2 0 0 1 2 2v9a1.6 1.6 0 0 0-1.6-1.6H3zM17 5h-5a2 2 0 0 0-2 2v9a1.6 1.6 0 0 1 1.6-1.6H17z"/>'),
  edit: sv('<path d="M4 16h3.2L15.6 7.6l-3.2-3.2L4 12.8z"/>'),
  dot: sv('<circle cx="10" cy="10" r="2.2" fill="currentColor"/>'),
  plug: sv('<path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0zM10 15v2.5"/>'),
  user: sv('<circle cx="10" cy="7" r="3.2"/><path d="M3.8 17a6.2 6.2 0 0 1 12.4 0"/>'),
};
const MARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 2h6l3 3H5zM2 7h9v3H5L2 7zM11 12h3l-3 3H5v-3z" opacity=".9"/><path fill="currentColor" d="M11 5h3v1h-3zM2 5l3-3v5H2zM11 7l3 3v2h-3zM2 11h3v4l-3-3z" opacity=".45"/></svg>';
const KIND_ICON = { agent: I.agents, sh: I.term, run: I.term, js: I.code, py: I.code, wait: I.clock, ask: I.ask, checkpoint: I.inbox, choose: I.fork,
  par: I.par, pipe: I.pipe, lane: I.lane, wf: I.workflows, workflow: I.workflows, gate: I.gate, retry: I.loop, bp: I.bp, attempt: I.loop, dec: I.fork, if: I.fork };
const KIND_NAME = { agent: "agent", sh: "sh", run: "run", js: "js", py: "py", wait: "waitUntil", ask: "ask", checkpoint: "checkpoint", choose: "choose",
  par: "parallel", pipe: "pipeline", lane: "pipeline item", wf: "workflow", gate: "gate", retry: "retry", bp: "breakpoint", attempt: "attempt" };
const ki = (k) => '<span class="ki">' + (KIND_ICON[k] || I.code) + "</span>";
const ic = (name) => '<span class="ic">' + I[name] + "</span>";

/* status icons: shape alone tells them apart */
const ST_LABEL = { done: "Done", running: "Running", failed: "Failed", waiting: "Needs you", paused: "Paused", stopped: "Stopped", queued: "Queued", skipped: "Skipped" };
function si(s, label) {
  const a = label === false ? ' aria-hidden="true"' : ' role="img" aria-label="' + esc(label || ST_LABEL[s] || s) + '"';
  const o = '<svg class="si' + (s === "running" ? " spin" : "") + '" viewBox="0 0 14 14"' + a + ">";
  switch (s) {
    case "done": return o + '<circle cx="7" cy="7" r="5.9" fill="none" stroke="var(--done)" stroke-width="1.3"/><path d="m4.4 7.2 1.8 1.8 3.5-3.8" fill="none" stroke="var(--done)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case "running": return o + '<circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--run)" stroke-opacity=".3" stroke-width="1.6"/><path d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="var(--run)" stroke-width="1.6" stroke-linecap="round"/></svg>';
    case "failed": return o + '<circle cx="7" cy="7" r="6.3" fill="var(--fail)"/><path d="m4.9 4.9 4.2 4.2M9.1 4.9 4.9 9.1" stroke="var(--bg-raised)" stroke-width="1.5" stroke-linecap="round"/></svg>';
    case "waiting": return o + '<circle cx="7" cy="7" r="6.3" fill="var(--needs)"/><path d="M7 3.8v3.9" stroke="var(--bg-raised)" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10" r=".95" fill="var(--bg-raised)"/></svg>';
    case "paused": return o + '<circle cx="7" cy="7" r="5.9" fill="none" stroke="var(--pause)" stroke-width="1.3"/><path d="M5.6 4.9v4.2M8.4 4.9v4.2" stroke="var(--pause)" stroke-width="1.5" stroke-linecap="round"/></svg>';
    case "stopped": return o + '<circle cx="7" cy="7" r="5.9" fill="none" stroke="var(--icon-muted)" stroke-width="1.3"/><rect x="4.9" y="4.9" width="4.2" height="4.2" rx=".7" fill="var(--icon-muted)"/></svg>';
    case "skipped": return o + '<circle cx="7" cy="7" r="5.9" fill="none" stroke="var(--icon-muted)" stroke-width="1.3"/><path d="M4.6 7h4.8" stroke="var(--icon-muted)" stroke-width="1.4" stroke-linecap="round"/></svg>';
    default: return o + '<circle cx="7" cy="7" r="5.7" fill="none" stroke="var(--icon-muted)" stroke-width="1.3" stroke-dasharray="2.4 2"/></svg>';
  }
}
const runIcon = (r) => ({ question: "waiting", breakpoint: "waiting" })[r.status] || r.status;
const needsYou = (r) => r.status === "question" || r.status === "breakpoint";

/* ------------------------------------------------------------------ markdown, code, diff */
function highlight(line, mode) {
  if (mode === "plain") return esc(line);
  if (mode === "md") {
    if (/^#{1,6} /.test(line)) return '<span class="syn-h">' + esc(line) + "</span>";
    if (/^(---|```)/.test(line)) return '<span class="syn-com">' + esc(line) + "</span>";
    const fm = line.match(/^([\w-]+):( .*)?$/);
    if (fm) return '<span class="syn-kw">' + esc(fm[1]) + "</span>:" + esc(fm[2] || "");
    return esc(line).replace(/`([^`]+)`/g, '<span class="syn-str">`$1`</span>').replace(/\*\*([^*]+)\*\*/g, '<span class="syn-kw">**$1**</span>');
  }
  if (mode === "toml") {
    const kv = line.match(/^(\s*)([\w.]+)(\s*=\s*)(.*)$/);
    if (kv) return esc(kv[1]) + '<span class="syn-kw">' + esc(kv[2]) + "</span>" + esc(kv[3]) + '<span class="syn-str">' + esc(kv[4]) + "</span>";
    return /^\s*#/.test(line) ? '<span class="syn-com">' + esc(line) + "</span>" : esc(line);
  }
  const re = /(\/\/.*$)|(`(?:\\.|[^`])*`?|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')|\b(export|const|await|return|async|for|of|if|let|break|true|false|null)\b|\b(agent|sh|js|py|run|ask|breakpoint|workflow|parallel|pipeline|gate|retry|choose|checkpoint|waitUntil|log)(?=\()/g;
  let out = "", last = 0, m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    const cls = m[1] ? "syn-com" : m[2] ? "syn-str" : m[3] ? "syn-kw" : "syn-fn";
    out += '<span class="' + cls + '">' + esc(m[0]) + "</span>";
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + esc(line.slice(last));
}
function codeBlock(text, o) {
  o = o || {};
  const lines = String(text).replace(/\n$/, "").split("\n");
  const hit = o.hit || [];
  return '<div class="code' + (o.wrap ? " wrap" : "") + '">' + (o.path ? '<div class="cp"><span class="p">' + esc(o.path) + "</span><span>" + plural(lines.length, "line") + "</span>" + (o.copy ? '<button class="copy" data-copy="' + esc(text) + '" aria-label="Copy the file">' + I.copy + "</button>" : "") + "</div>" : "") +
    '<div class="in"' + (o.wrap ? "" : ' data-scroll-x tabindex="0" role="region" aria-label="' + esc(o.label || "Code") + '"') + ">" +
    lines.map((l, i) => '<div class="ln' + (hit.includes(i + (o.start || 1)) ? " hit" : "") + '"><span class="no">' + (i + (o.start || 1)) + '</span><span class="tx">' + highlight(l, o.mode || "js") + "</span></div>").join("") + "</div></div>";
}
function diffOps(a, b) {
  const A = a.replace(/\n$/, "").split("\n"), B = b.replace(/\n$/, "").split("\n");
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push([" ", A[i], j + 1]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(["-", A[i], null]); i++; }
    else { ops.push(["+", B[j], j + 1]); j++; }
  }
  while (i < n) ops.push(["-", A[i++], null]);
  while (j < m) { ops.push(["+", B[j], j + 1]); j++; }
  return ops;
}
function diffBlock(a, b, path) {
  const ops = diffOps(a, b);
  const keep = ops.map(() => false);
  ops.forEach((o, i) => { if (o[0] !== " ") for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) keep[k] = true; });
  let out = "", skipped = 0;
  const gap = () => { if (skipped) out += '<div class="ln gap"><span class="no"></span><span class="tx">' + plural(skipped, "line") + " without changes</span></div>"; skipped = 0; };
  const adds = ops.filter((o) => o[0] === "+").length, dels = ops.filter((o) => o[0] === "-").length;
  ops.forEach((o, i) => {
    if (!keep[i]) { skipped++; return; }
    gap();
    const cls = o[0] === "+" ? " add" : o[0] === "-" ? " del" : "";
    out += '<div class="ln' + cls + '"><span class="no">' + (o[2] || "") + '</span><span class="tx">' + (o[0] === " " ? " " : o[0]) + " " + highlight(o[1], "js") + "</span></div>";
  });
  gap();
  return '<div class="code"><div class="cp"><span class="p">' + esc(path) + "</span><span>" + adds + " added, " + dels + ' removed</span></div><div class="in" data-scroll-x tabindex="0" role="region" aria-label="Changes since you approved">' + out + "</div></div>";
}
function splitFm(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: text };
  return { fm: m[1].split("\n").map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }), body: m[2] };
}
function md(text, withFm) {
  const { fm, body } = splitFm(text);
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  let out = withFm && fm ? '<table class="fm"><tbody>' + fm.map(([k, v]) => "<tr><th>" + esc(k) + "</th><td>" + esc(v) + "</td></tr>").join("") + "</tbody></table>" : "";
  let list = null, fence = null;
  const close = () => { if (list) { out += "</" + list + ">"; list = null; } };
  body.split("\n").forEach((l) => {
    if (fence !== null) {
      if (/^```/.test(l)) { out += '<pre tabindex="0" data-scroll-x><code>' + esc(fence.replace(/\n$/, "")) + "</code></pre>"; fence = null; } else fence += l + "\n";
      return;
    }
    if (/^```/.test(l)) { close(); fence = ""; return; }
    const ul = l.match(/^\s*[-*] (.*)$/), ol = l.match(/^\d+\. (.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) { close(); out += "<" + want + ">"; list = want; }
      out += "<li>" + inline((ul || ol)[1]) + "</li>";
      return;
    }
    close();
    const h = l.match(/^(#{1,4}) (.*)$/);
    if (h) out += "<h" + Math.min(3, h[1].length + 1) + ">" + inline(h[2]) + "</h" + Math.min(3, h[1].length + 1) + ">";
    else if (l.trim()) out += "<p>" + inline(l) + "</p>";
  });
  close();
  return out;
}
/* Rendered and Raw, the same switch at the top right of every markdown block */
const mdView = (key) => ui.md[key] || "rendered";
function mdSwitch(key) {
  const v = mdView(key);
  return '<span class="seg" role="group" aria-label="Show as">' + [["rendered", "Rendered"], ["raw", "Raw"]].map(([k, l]) =>
    '<button type="button" data-md="' + esc(key) + "|" + k + '" aria-pressed="' + (v === k) + '">' + l + "</button>").join("") + "</span>";
}
function mdBlock(key, text, o) {
  o = o || {};
  const raw = mdView(key) === "raw";
  return '<div class="mdblk"><div class="bh">' + (o.path ? '<span class="p">' + esc(o.path) + "</span>" : "<span>" + (o.labelHtml || esc(o.label || "Markdown")) + "</span>") + '<span class="r">' + mdSwitch(key) + "</span></div>" +
    (raw ? codeBlock(o.rawText || text, { mode: o.mode || "md", wrap: true }) : '<div class="prose">' + md(text, o.fm) + "</div>") + "</div>";
}
/* A path breaks only after a slash, and the copy button stays on the line of the file name. */
const pathHtml = (path, copy) => {
  const segs = String(path).split("/");
  return '<span class="path">' + segs.map((x, i) => i < segs.length - 1 ? '<span class="pseg">' + esc(x) + "/</span><wbr>" :
    '<span class="pseg">' + esc(x) + (copy ? '<button class="copy" data-copy="' + esc(path) + '" aria-label="' + esc(copy) + '">' + I.copy + "</button>" : "") + "</span>").join("") + "</span>";
};
/* A command wraps at its spaces, so it reads whole at 375. A short word such as r-8d2v7f or --budget stays on one line,
   and a long path breaks after a slash. */
const cmdBox = (c, label) => '<span class="cmd"><code>' + String(c).split(" ").map((t) => t.length <= 24 ? '<span class="nw">' + esc(t) + "</span>" : esc(t).replace(/\//g, "/<wbr>")).join(" ") + '</code><button class="copy" data-copy="' + esc(c) + '" aria-label="' + esc(label || "Copy the command") + '">' + I.copy + "</button></span>";
const shq = (s) => /^[\w.\/:@-]+$/.test(String(s)) ? String(s) : '"' + String(s).replace(/"/g, '\\"') + '"';

/* ------------------------------------------------------------------ ui state */
const ui = {
  theme: store.get("theme", "auto"),
  groupBy: store.get("groupBy", "status"),
  mode: null,            // a state picked in the States menu: down, lost, loading, first, noruns, nowf, noagents, noskills, nomcp, many
  q: {}, project: "",    // list filters
  from: "orchestrator",  // "Seen from" for agents, skills and MCP
  md: {}, fold: {}, gfold: {}, zoom: {}, harness: {}, showAll: {}, tellResult: {},
  removed: new Set(), gone: null, answered: {}, colOpen: false, route: null, startVals: {}, lookOpen: {},
};
/* While the service is down, nothing that changes a run works. Those controls stay focusable and say why. */
const DOWN_WHY = "The sous service is not running. Start it with sous daemon start first.";
const downAttr = () => ui.mode === "down" ? ' aria-disabled="true" data-tip="' + DOWN_WHY + '"' : "";
function downBlock() { if (ui.mode !== "down") return false; toast("The sous service is not running", "sous daemon start"); return true; }
const SECTIONS = [
  { id: "runs", label: "Runs", icon: "runs", key: "r" },
  { id: "workflows", label: "Workflows", icon: "workflows", key: "w" },
  { id: "agents", label: "Agents", icon: "agents", key: "a" },
  { id: "skills", label: "Skills", icon: "skills", key: "s" },
  { id: "mcp", label: "MCP servers", icon: "mcp", key: "m" },
];
const ALL_PROJECTS = ["orchestrator", "site", "docs", "billing", "mobile", "infra"];

function liveRuns() {
  if (ui.mode === "first" || ui.mode === "noruns") return [];
  if (ui.mode === "many") return MANY || (MANY = manyRuns());
  return RUNS.filter((r) => !ui.removed.has(r.id));
}
let MANY = null;
const runById = (id) => RUNS.find((r) => r.id === id);
const liveWorkflows = () => ui.mode === "first" || ui.mode === "nowf" ? [] : WORKFLOWS.filter((w) => !w.deleted);
const liveAgents = () => ui.mode === "first" || ui.mode === "noagents" ? [] : Object.keys(AGENT_DEFS).filter((a) => AGENT_DEFS[a].copies.some((c) => !FOLDER[c.at].project || c.project === ui.from));
const liveSkills = () => ui.mode === "first" || ui.mode === "noskills" ? [] : Object.keys(SKILLS);
const liveMcps = () => ui.mode === "first" || ui.mode === "nomcp" ? [] : Object.keys(MCPS);
const needsCount = () => liveRuns().filter(needsYou).length;

/* ------------------------------------------------------------------ router. #/<section>/<id>/<sub>?k=v */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const qi = h.indexOf("?");
  const path = qi < 0 ? h : h.slice(0, qi), qs = qi < 0 ? "" : h.slice(qi + 1);
  const parts = path.split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
  const params = {};
  new URLSearchParams(qs).forEach((v, k) => { params[k] = v; });
  return { sec: parts[0] || "runs", id: parts[1] || null, sub: parts[2] || null, params, parts };
}
function hashFor(r, params) {
  const p = Object.assign({}, r.params, params || {});
  Object.keys(p).forEach((k) => { if (p[k] == null || p[k] === "") delete p[k]; });
  const qs = new URLSearchParams(p).toString();
  return "#/" + r.parts.map(enc).join("/") + (qs ? "?" + qs : "");
}
/* change a parameter of the current page without a new history entry, then draw again */
function setParams(params, o) {
  const r = parseHash();
  if (!r.parts.length) r.parts = [r.sec];
  const h = hashFor(r, params);
  try { history.replaceState(null, "", h); } catch (e) { location.hash = h; return; }
  route(Object.assign({ keepScroll: true }, o || {}));
}
const STICKY = ["down", "lost", "many"];
const MODES = ["down", "lost", "loading", "first", "noruns", "nowf", "noagents", "noskills", "nomcp", "many", "grapherr", "feederr"];
const LIST_SECS = ["runs", "workflows", "agents", "skills", "mcp"];
/* Under 700px a section without an item picked shows its list as the page. */
const listOnly = (r) => window.innerWidth < 700 && !r.id && LIST_SECS.includes(r.sec) && !["loading", "first"].includes(ui.mode);
function route(o) {
  o = o || {};
  const r = parseHash();
  if (!SECTIONS.some((s) => s.id === r.sec) && r.sec !== "settings") r.sec = "runs";
  let m = ui.mode;
  if (r.params.state) m = r.params.state === "normal" ? null : MODES.includes(r.params.state) ? r.params.state : ui.mode;
  else if (m && !STICKY.includes(m)) m = null;
  if (m !== ui.mode) { ui.mode = m; MANY = null; startBars(); }
  if ("q" in r.params) ui.q[r.sec] = r.params.q;
  if ("project" in r.params) ui.project = r.params.project;
  if (r.params.from && (PROJECTS.includes(r.params.from) || r.params.from === "home")) ui.from = r.params.from === "home" ? "orchestrator" : r.params.from;
  const prev = ui.route;
  ui.route = r;
  if (!o.keepCol) ui.colOpen = false;
  document.body.classList.toggle("col-open", ui.colOpen);
  $("#scrim").hidden = !ui.colOpen;
  closePops();
  renderRail();
  renderCol();
  renderStates();
  const main = $("#main"), top = main.scrollTop;
  const lo = listOnly(r);
  document.body.classList.toggle("list-only", lo);
  main.innerHTML = lo ? "" : renderMain(r) + '<p class="sample-foot">Sample data</p>';
  if (o.keepScroll) main.scrollTop = top; else main.scrollTop = 0;
  afterRender(r, prev);
  if (ui.focusTitle) { ui.focusTitle = false; const h = lo ? $("#col h2") : $("#main h1"); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); } }
  if (r.params.search != null && !o.noSearch) openSearch(r.params.search);
}
function renderMain(r) {
  if (ui.mode === "loading") return loadingPage(r);
  if (ui.mode === "first") return firstPage();
  if (r.sec === "settings") return settingsPage();
  if (r.sec === "runs") {
    if (r.id === "new") return startPage(r.sub, r.params);
    const list = liveRuns();
    if (!list.length) return runsEmptyPage();
    const id = r.id || (sortedRuns(list)[0] || {}).id;
    const run = runById(id);
    if (run && ui.removed.has(id)) return '<div class="page">' + crumbs([["Runs", "#/runs"], [run.project, "#/runs?project=" + enc(run.project)], [run.id]]) +
      '<div class="empty"><h1 class="title">Run removed</h1><p>' + esc(run.label) + ", " + esc(run.id) + ", is no longer in the list.</p>" +
      (ui.gone === id ? '<button class="btn" data-unremove="' + esc(id) + '">Undo</button>' : "") + "</div></div>";
    if (!run || ui.removed.has(id)) return missingPage("run", id, "#/runs");
    return runPage(run, r.params);
  }
  if (r.sec === "workflows") {
    const list = liveWorkflows();
    if (!list.length) return wfEmptyPage();
    const w = WF[r.id || list[0].name];
    if (!w || w.deleted) return missingPage("workflow", r.id, "#/workflows");
    return wfPage(w, r.sub, r.params);
  }
  if (r.sec === "agents") {
    const list = liveAgents();
    if (!list.length) return folderEmptyPage("agents");
    const name = r.id || list[0];
    if (!AGENT_DEFS[name]) return missingPage("agent", name, "#/agents");
    return agentPage(name, r.params);
  }
  if (r.sec === "skills") {
    const list = liveSkills();
    if (!list.length) return folderEmptyPage("skills");
    const name = r.id || list[0];
    if (!SKILLS[name]) return missingPage("skill", name, "#/skills");
    return skillPage(name);
  }
  if (r.sec === "mcp") {
    const list = liveMcps();
    if (!list.length) return folderEmptyPage("mcp");
    const name = r.id || list[0];
    if (!MCPS[name]) return missingPage("MCP server", name, "#/mcp");
    return mcpPage(name);
  }
  return "";
}
function missingPage(what, id, back) {
  return '<div class="page"><div class="empty"><h1 class="title">No ' + esc(what) + " named " + esc(id) + "</h1><p>It may have been removed, or the link is old.</p>" +
    '<a class="btn" href="' + back + '">Show the list</a></div></div>';
}
function loadingPage(r) {
  const sk = (w, h) => '<span class="skel" style="width:' + w + (h ? ";height:" + h + "px" : "") + '"></span>';
  const n = (k, f) => Array.from({ length: k }, (x, i) => f(i)).join("");
  /* each page's skeleton has the shape of that page: its header, then its own blocks */
  const head = (run) => sk("160px", 8) + (run ? '<div class="sktl"><span class="skel t"></span>' + sk("64px", 12) + sk("120px", 12) + "</div>" : '<span class="skel t"></span>' + sk("55%") + sk("36%", 8));
  const pairs = (k) => '<div class="pairs">' + n(k, () => "<div>" + sk("50%", 8) + sk("70%") + "</div>") + "</div>";
  const viewbar = '<div class="skbar">' + sk("120px", 26) + sk("90px", 8) + "</div>";
  const graph = '<div class="skgraph">' + n(4, () => '<span class="sknode"><span class="c"></span>' + sk("60%") + "</span>") + "</div>";
  const steps = n(7, (i) => '<div class="srow" style="grid-template-columns:var(--lc) 1fr"><div class="scell">' + sk((40 + (i * 19) % 35) + "%") + '</div><div class="tcell"></div></div>');
  const runs = '<div class="runlist">' + n(4, (i) => '<div class="row ske"><span class="c"></span>' + sk((45 + (i * 17) % 30) + "%") + "</div>") + "</div>";
  const h2 = (w) => '<div class="skh">' + sk(w || "120px", 12) + "</div>";
  const kv = (k) => '<div class="skkv">' + n(k, (i) => sk("70%") + sk((40 + (i * 17) % 45) + "%")) + "</div>";
  const lines = (k) => '<div class="sklines">' + n(k, (i) => sk((60 + (i * 23) % 38) + "%")) + "</div>";
  const doc = (k) => '<div class="skmd"><div class="bh">' + sk("30%", 8) + "</div>" + lines(k) + "</div>";
  const chips = (k) => '<div class="skchips">' + n(k, (i) => sk((80 + (i * 29) % 60) + "px", 28)) + "</div>";
  const fields = (k) => n(k, () => '<div class="skfld">' + sk("25%", 8) + '<span class="skin"></span></div>');
  let body;
  if (r.sec === "runs" && r.id === "new") body = head() + fields(4) + '<div class="skbar start">' + sk("90px", 30) + sk("70px", 30) + "</div>";
  else if (r.sec === "runs") body = head(true) + pairs(6) + viewbar + (r.params.view === "graph" ? graph : steps);
  else if (r.sec === "workflows") body = head() + pairs(5) + viewbar + graph + h2("80px") + runs;
  else if (r.sec === "agents") body = head() + pairs(4) + h2() + sk("180px", 26) + kv(5) + h2() + lines(6);
  else if (r.sec === "skills") body = head() + h2("80px") + doc(9) + h2() + lines(2) + h2() + chips(5);
  else if (r.sec === "mcp") body = head() + pairs(3) + h2() + kv(4) + h2() + doc(7) + h2() + chips(4);
  else body = sk("80px", 8) + '<span class="skel t"></span>' + h2("60px") + sk("260px", 26) + h2() + kv(3) + h2() + kv(8);
  return '<div class="page skelpage" aria-busy="true"><span class="vh">Loading</span>' + body + "</div>";
}
function firstPage() {
  return '<div class="page"><div class="empty"><h1 class="title">Nothing in sous home yet</h1>' +
    "<p>This is the first time sous runs on this computer. ~/.sous holds no workflow and no run, and sous found no agent, skill or MCP server.</p>" +
    "<p>Start with the guide. It writes a first workflow with you and runs it.</p>" + cmdBox("sous guide") +
    '<p style="margin-top:16px">Or run a workflow from a file you already have.</p>' + cmdBox("sous run ./ticket.js --ticket \"Add a --json flag\"") + "</div></div>";
}
function runsEmptyPage() {
  const proj = ui.project && ui.mode !== "noruns";
  return '<div class="page"><div class="empty"><h1 class="title">No runs yet</h1><p>A run starts when you, a schedule or an agent starts a workflow. Start one here or from a terminal.</p>' +
    cmdBox('sous run ticket --ticket "Add a --json flag to sous list"') + '<div class="form-acts"><a class="btn primary" href="#/runs/new/ticket">Start ticket</a><a class="btn" href="#/workflows">See the workflows</a></div></div></div>';
}

/* ------------------------------------------------------------------ rail */
function renderRail() {
  const r = ui.route, n = needsCount();
  const sec = (s) => {
    const cur = r.sec === s.id;
    const badge = s.id === "runs" && n ? '<span class="badge" aria-hidden="true">' + n + "</span>" : "";
    const label = s.label + (s.id === "runs" && n ? ", " + n + " need you" : "");
    return '<a class="rbtn" href="#/' + s.id + '" aria-label="' + esc(label) + '" data-tip="' + esc(s.label) + "  g " + s.key + '"' + (cur ? ' aria-current="page"' : "") + ">" + I[s.icon] + badge + "</a>";
  };
  const themeIcon = ui.theme === "dark" ? I.moon : ui.theme === "light" ? I.sun : I.auto;
  const themeLabel = "Theme: " + ui.theme + ". Switch the theme";
  $("#rail").innerHTML = '<span class="mark" aria-hidden="true">' + MARK + "</span>" +
    '<button class="rbtn rail-menu" data-col aria-label="Show the list" aria-expanded="' + ui.colOpen + '">' + I.list + "</button>" +
    SECTIONS.map(sec).join("") + '<span class="sep"></span>' +
    '<button class="rbtn" data-search aria-label="Search agents, skills and MCP servers" data-tip="Search  /">' + I.search + "</button>" +
    '<span class="sp"></span>' +
    '<button class="rbtn" data-states aria-label="States" aria-haspopup="true" aria-expanded="' + !$("#states").hidden + '" data-tip="States of the mock">' + I.states + "</button>" +
    '<a class="rbtn" href="#/settings" aria-label="Settings" data-tip="Settings"' + (r.sec === "settings" ? ' aria-current="page"' : "") + ">" + I.gear + "</a>" +
    '<button class="rbtn wide-only" data-theme-toggle aria-label="' + esc(themeLabel) + '" data-tip="' + esc(themeLabel) + '">' + themeIcon + "</button>" +
    '<span class="sample">Sample data</span>';
}
function applyTheme() {
  if (ui.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", ui.theme);
}

/* ------------------------------------------------------------------ list column */
const STATUS_GROUPS = [
  { id: "needs", label: "Needs you", test: needsYou },
  { id: "failed", label: "Failed", test: (r) => r.status === "failed" },
  { id: "running", label: "Running", test: (r) => r.status === "running" },
  { id: "paused", label: "Paused", test: (r) => r.status === "paused" },
  { id: "done", label: "Done", test: (r) => r.status === "done" || r.status === "stopped" },
];
const sortedRuns = (list) => {
  const out = [];
  STATUS_GROUPS.forEach((g) => list.filter(g.test).sort((a, b) => b.startedAt - a.startedAt).forEach((r) => out.push(r)));
  return out;
};
function runMatches(r, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return (r.label + " " + r.wf + " " + r.project).toLowerCase().includes(q);
}
function runRowHtml(r, o) {
  o = o || {};
  /* a removed run keeps its place until you leave, so the next row does not slide under the pointer */
  if (ui.gone === r.id) return '<div class="row gone"><span class="t">Removed ' + esc(r.label) + '</span><button class="btn sm" data-unremove="' + esc(r.id) + '" aria-label="Undo, put ' + esc(r.label) + ' back">Undo</button></div>';
  const rt = ui.route, sel = rt && rt.sec === "runs" && !r.gen && rt.id !== "new" && (rt.id || (!listOnly(rt) && ui.shownRun)) === r.id;
  const canX = !r.gen && ["done", "stopped", "failed"].includes(r.status);
  /* the right column is the time since the run started, in every group, so it grows down each group as the sort does */
  const age = r.startedAt;
  const nm = '<span class="nm">' + esc(r.label) + '<span class="muted">' + esc(r.wf) + (o.project ? ", " + esc(r.project) : "") + "</span></span>";
  return '<div class="row' + (sel ? " sel" : "") + (canX ? " has-x" : "") + '" data-tip="' + esc(r.label + ", " + r.wf + " in " + r.project) + '">' +
    '<a href="#/runs/' + enc(r.id) + '"' + (sel ? ' aria-current="page"' : "") + ">" + si(runIcon(r), ST_LABEL[runIcon(r)]) + nm +
    (needsYou(r) && !o.noDot ? '<span class="dot" aria-hidden="true"></span>' : "") +
    '<span class="age" data-tip="' + esc("Time since it started. Started " + fmtFull(age) + ".") + '"><span class="vh">started </span>' + esc(fmtAge(age)) + "</span></a>" +
    (canX ? '<button class="x" data-x="' + esc(r.id) + '" aria-label="Remove ' + esc(r.label) + ' from the list">' + I.x + "</button>" : "") + "</div>";
}
function listHead(title, count, extra, ph) {
  const sec = ui.route.sec;
  return '<div class="col-head"><div class="col-title"><h2>' + esc(title) + '</h2><span class="count">' + count + "</span>" +
    '<span class="r"><button class="ibtn col-close" data-col aria-label="Close the list">' + I.x + "</button></span></div>" +
    '<label class="field-s">' + I.search + '<span class="vh">' + esc(ph) + '</span><input type="text" data-filter="' + sec + '" placeholder="' + esc(ph) + '" value="' + esc(ui.q[sec] || "") + '" autocomplete="off"></label>' +
    (extra || "") + "</div>";
}
function renderCol() {
  const r = ui.route, sec = r.sec === "settings" ? "runs" : r.sec;
  let head = "", body = "";
  if (ui.mode === "loading") {
    head = listHead(SECTIONS.find((s) => s.id === sec).label, "", "", "Filter");
    body = '<div aria-busy="true"><span class="vh">Loading the list</span>' + [70, 55, 80, 62, 74, 50, 66, 58, 72].map((w) => '<div class="row ske"><span class="c"></span><span class="skel" style="width:' + w + '%"></span></div>').join("") + "</div>";
  } else if (sec === "runs") {
    ui.shownRun = (sortedRuns(liveRuns())[0] || {}).id;
    const live = liveRuns(), goneRun = ui.gone && ui.mode !== "many" && runById(ui.gone);
    const all = goneRun ? live.concat([goneRun]) : live;
    const q = ui.q.runs || "";
    const list = all.filter((x) => runMatches(x, q) && (!ui.project || x.project === ui.project));
    const cnt = (rs) => rs.filter((x) => x.id !== ui.gone).length;
    const projects = ALL_PROJECTS.filter((p) => ui.mode === "many" || PROJECTS.includes(p) || ui.project === p);
    const extra = '<div class="ctl-row"><span id="gb-l">Group by</span><span class="seg" role="group" aria-labelledby="gb-l">' +
      [["status", "Status"], ["project", "Project"]].map(([k, l]) => '<button type="button" data-group="' + k + '" aria-pressed="' + (ui.groupBy === k) + '">' + l + "</button>").join("") + "</span>" +
      '<label class="vh" for="pf">Project</label><select id="pf" data-project-filter><option value="">All projects</option>' + projects.map((p) => '<option value="' + p + '"' + (ui.project === p ? " selected" : "") + ">" + p + "</option>").join("") + "</select></div>";
    head = listHead("Runs", cnt(list), '<a class="btn start-btn" href="#/runs/new">' + I.plus + "Start a workflow</a>" + extra, "Filter runs");
    if (!live.length && !goneRun) {
      body = '<div class="col-empty"><p>No runs yet.</p><p>Start one from a workflow page, or from a terminal:</p>' + cmdBox("sous run ticket --ticket \"...\"") + "</div>";
    } else if (!list.length) {
      body = '<div class="col-empty"><p>No run ' + (ui.project ? "in " + esc(ui.project) + " " : "") + (q ? 'matches "' + esc(q) + '"' : "yet") + ".</p>" +
        "<p>The filter looked at the label, the workflow and the project of " + plural(live.length, "run") + ".</p>" +
        '<button class="btn sm" data-clear-filter>Clear the filter</button></div>';
    } else if (ui.groupBy === "project") {
      const needs = list.filter(needsYou).sort((a, b) => b.startedAt - a.startedAt);
      if (needs.length) body += '<h3 class="grp needs">Needs you <span class="n">' + needs.length + "</span></h3>" + needs.map((x) => runRowHtml(x, { project: true })).join("");
      ALL_PROJECTS.forEach((p) => {
        const rs = list.filter((x) => x.project === p && !needsYou(x)).sort((a, b) => b.startedAt - a.startedAt);
        if (rs.length) body += '<h3 class="grp">' + esc(p) + ' <span class="n">' + cnt(rs) + "</span></h3>" + rs.map((x) => runRowHtml(x)).join("");
      });
    } else {
      STATUS_GROUPS.forEach((g) => {
        const rs = list.filter(g.test).sort((a, b) => b.startedAt - a.startedAt);
        if (rs.length) body += '<h3 class="grp' + (g.id === "needs" ? " needs" : "") + '">' + g.label + ' <span class="n">' + cnt(rs) + "</span></h3>" + rs.map((x) => runRowHtml(x, { project: true, noDot: g.id === "needs" })).join("");
      });
    }
  } else if (sec === "workflows") {
    const all = liveWorkflows(), q = (ui.q.workflows || "").toLowerCase();
    const list = all.filter((w) => !q || (w.name + " " + w.description).toLowerCase().includes(q));
    head = listHead("Workflows", list.length, "", "Filter workflows");
    if (!all.length) body = '<div class="col-empty"><p>No saved workflows.</p><p>sous saves a workflow when you approve it. Write one with the guide:</p>' + cmdBox("sous guide") + "</div>";
    else if (!list.length) body = '<div class="col-empty"><p>No workflow matches "' + esc(q) + '".</p><button class="btn sm" data-clear-filter>Clear the filter</button></div>';
    else {
      const groups = [["home", "Home, ~/.sous/workflows"]].concat(PROJECTS.map((p) => [p, p]));
      groups.forEach(([g, l]) => {
        const ws = list.filter((w) => w.where === g);
        if (!ws.length) return;
        body += '<h3 class="grp">' + esc(l) + ' <span class="n">' + ws.length + "</span></h3>" + ws.map((w) => {
          const sel = ui.route.sec === "workflows" && (ui.route.id || all[0].name) === w.name;
          const tag = w.problems ? '<span class="tag bad">problem</span>' : w.approved.changedSince ? '<span class="tag">changed</span>' : "";
          return '<div class="row' + (sel ? " sel" : "") + '" data-tip="' + esc(w.path) + '"><a href="#/workflows/' + enc(w.name) + '"' + (sel ? ' aria-current="page"' : "") + ">" + ic("workflows") + '<span class="nm">' + esc(w.name) + "</span>" + tag + "</a></div>";
        }).join("");
      });
    }
  } else {
    const kind = sec;
    const names = kind === "agents" ? liveAgents() : kind === "skills" ? liveSkills() : liveMcps();
    const q = (ui.q[kind] || "").toLowerCase();
    const descOf = (n) => kind === "agents" ? AGENT_DEFS[n].description : kind === "skills" ? SKILLS[n].description : mcpLine(MCPS[n]);
    const list = names.filter((n) => !q || (n + " " + descOf(n)).toLowerCase().includes(q));
    const title = kind === "agents" ? "Agents" : kind === "skills" ? "Skills" : "MCP servers";
    const seen = '<div class="ctl-row"><label class="pick" for="seen">Seen from</label><select id="seen" data-from>' + PROJECTS.map((p) => '<option value="' + p + '"' + (ui.from === p ? " selected" : "") + ">" + p + "</option>").join("") + "</select></div>";
    head = listHead(title, list.length, seen, "Filter " + title.toLowerCase());
    if (!names.length) body = '<div class="col-empty">' + emptyFolderText(kind) + "</div>";
    else if (!list.length) body = '<div class="col-empty"><p>Nothing matches "' + esc(q) + '".</p><button class="btn sm" data-clear-filter>Clear the filter</button></div>';
    else body = list.map((n) => {
      const sel = ui.route.sec === kind && (ui.route.id || names[0]) === n;
      const sub = kind === "agents" ? agentHarness(effDef(n, ui.from)) : kind === "mcp" ? MCPS[n].type : "";
      return '<div class="row' + (sel ? " sel" : "") + '" data-tip="' + esc(descOf(n)) + '"><a href="#/' + kind + "/" + enc(n) + '"' + (sel ? ' aria-current="page"' : "") + ">" + ic(kind === "mcp" ? "mcp" : kind) +
        '<span class="nm">' + esc(n) + "</span>" + (sub ? '<span class="tag">' + esc(sub) + "</span>" : "") + "</a></div>";
    }).join("");
  }
  $("#col").innerHTML = head + '<div class="col-body" tabindex="-1">' + body + "</div>";
}
function emptyFolderText(kind) {
  if (kind === "agents") return "<p>No agents in the folders sous reads.</p><p>sous looks in .rulesync/subagents, .claude/agents and .codex/agents of the project, then in ~/rulesync, ~/.claude/agents and ~/.codex/agents. Add a file to one of them:</p>" + cmdBox("~/.claude/agents/reviewer.md", "Copy the path");
  if (kind === "skills") return "<p>No skills in the folders sous reads.</p><p>sous looks in ~/rulesync/.rulesync/skills, ~/.claude/skills and ~/.codex/skills. A skill is a folder with a SKILL.md in it.</p>" + cmdBox("~/.claude/skills/code-review/SKILL.md", "Copy the path");
  return "<p>No MCP servers in the files sous reads.</p><p>sous reads mcp.jsonc in ~/rulesync/.rulesync and in the project's .rulesync folder.</p>" + cmdBox("~/rulesync/.rulesync/mcp.jsonc", "Copy the path");
}
function folderEmptyPage(kind) {
  const title = kind === "agents" ? "No agents yet" : kind === "skills" ? "No skills yet" : "No MCP servers yet";
  return '<div class="page"><div class="empty"><h1 class="title">' + title + "</h1>" + emptyFolderText(kind) + "</div></div>";
}
const mcpLine = (m) => m.type === "stdio" ? m.command + " " + m.args.join(" ") : m.url.replace(/^https?:\/\//, "");

/* ------------------------------------------------------------------ search, over agents, skills and MCP servers */
let searchSel = 0, searchItems = [];
function searchResults(q) {
  const s = q.trim().toLowerCase();
  const out = [];
  if (!s) return out;
  liveAgents().forEach((n) => { const d = effDef(n, ui.from); const hay = (n + " " + d.description + " " + d.body).toLowerCase(); if (hay.includes(s)) out.push({ kind: "Agents", icon: "agents", name: n, sub: d.description, href: "#/agents/" + enc(n) }); });
  liveSkills().forEach((n) => { const k = SKILLS[n]; if ((n + " " + k.description + " " + k.text).toLowerCase().includes(s)) out.push({ kind: "Skills", icon: "skills", name: n, sub: k.description, href: "#/skills/" + enc(n) }); });
  liveMcps().forEach((n) => { const m = MCPS[n]; if ((n + " " + mcpLine(m)).toLowerCase().includes(s)) out.push({ kind: "MCP servers", icon: "mcp", name: n, sub: mcpLine(m), href: "#/mcp/" + enc(n) }); });
  return out;
}
const hlq = (text, q) => { const i = text.toLowerCase().indexOf(q.toLowerCase()); return i < 0 || !q ? esc(text) : esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length)); };
function renderSearchResults(q) {
  searchItems = searchResults(q);
  if (searchSel >= searchItems.length) searchSel = 0;
  const box = $("#sres");
  if (!box) return;
  const inp = $("#sq");
  if (searchItems.length) box.setAttribute("role", "listbox"); else box.removeAttribute("role");
  if (!q.trim()) { box.innerHTML = '<div class="none">Type a name or a word from a prompt. The search looks at ' + plural(liveAgents().length, "agent") + ", " + plural(liveSkills().length, "skill") + " and " + plural(liveMcps().length, "MCP server") + ", seen from " + esc(ui.from) + ".</div>"; inp.removeAttribute("aria-activedescendant"); return; }
  if (!searchItems.length) {
    box.innerHTML = '<div class="none" role="status">No agent, skill or MCP server matches <b>"' + esc(q) + '"</b>. The search looked at the names, descriptions and prompts of ' + plural(liveAgents().length, "agent") + ", " + plural(liveSkills().length, "skill") + " and " + plural(liveMcps().length, "MCP server") + ", in the folders seen from " + esc(ui.from) + ".</div>";
    inp.removeAttribute("aria-activedescendant");
    return;
  }
  let html = "", last = null;
  searchItems.forEach((it, i) => {
    if (it.kind !== last) { if (last) html += "</div>"; html += '<div role="group" aria-label="' + it.kind + '"><div class="rh" aria-hidden="true">' + it.kind + "</div>"; last = it.kind; }
    html += '<a class="ri" role="option" id="sr-' + i + '" href="' + it.href + '" aria-selected="' + (i === searchSel) + '">' + ic(it.icon) + '<span class="t"><b>' + hlq(it.name, q.trim()) + "</b><span>" + esc(it.sub) + "</span></span></a>";
  });
  box.innerHTML = html + "</div>";
  inp.setAttribute("aria-activedescendant", "sr-" + searchSel);
}
let searchReturn = null;
function openSearch(q) {
  const w = $("#search");
  if (!w.hidden) { const i = $("#sq"); i.value = q || i.value; renderSearchResults(i.value); i.focus(); return; }
  searchReturn = document.activeElement;
  w.innerHTML = '<div class="search" role="dialog" aria-modal="true" aria-label="Search agents, skills and MCP servers">' +
    '<label class="field-s">' + I.search + '<span class="vh">Search agents, skills and MCP servers</span><input id="sq" type="text" role="combobox" aria-expanded="true" aria-controls="sres" aria-autocomplete="list" placeholder="Search agents, skills and MCP servers" autocomplete="off" value="' + esc(q || "") + '"></label>' +
    '<div class="res" id="sres" role="listbox" aria-label="Results"></div>' +
    '<div class="foot"><span><kbd>Up</kbd> <kbd>Down</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div></div>';
  w.hidden = false;
  $("#app").inert = true;
  searchSel = 0;
  renderSearchResults(q || "");
  const i = $("#sq");
  i.focus();
  i.setSelectionRange(i.value.length, i.value.length);
}
function closeSearch() {
  const w = $("#search");
  if (w.hidden) return false;
  w.hidden = true; w.innerHTML = "";
  $("#app").inert = !$("#dlg").hidden;
  if (ui.route && ui.route.params.search != null) { const r = parseHash(); delete r.params.search; try { history.replaceState(null, "", hashFor(r)); } catch (e) { /* file urls */ } ui.route = parseHash(); }
  if (searchReturn && document.contains(searchReturn)) searchReturn.focus();
  return true;
}

/* ------------------------------------------------------------------ toast */
let toastTimer = null, undoFn = null;
function toast(msg, cmd, undo) {
  const t = $("#toast");
  t.innerHTML = "<span>" + esc(msg) + "</span>" + (cmd ? '<span class="c">' + esc(cmd) + "</span>" : "") + (undo ? '<button type="button" data-undo>Undo</button>' : "");
  undoFn = undo || null;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("on"); undoFn = null; }, undo ? 8000 : 5000);
}

/* Opening a search result puts focus on the new page's title. */
function openResult(href) {
  ui.focusTitle = true;
  if (location.hash === href) route({ keepScroll: true }); else location.hash = href;
}

/* ------------------------------------------------------------------ popovers: the States menu and the More menus */
/* The button that opened a popover, so Escape can send focus back to it. A re-render may replace it, so keep a selector too. */
let popReturn = null, popReturnSel = "";
function setPopReturn(btn) {
  popReturn = btn;
  popReturnSel = btn.hasAttribute("data-states") ? "[data-states]" : '[data-menu="' + btn.getAttribute("data-menu") + '"]' + (btn.hasAttribute("data-wf") ? '[data-wf="' + btn.getAttribute("data-wf") + '"]' : "");
}
function focusPopReturn() {
  const b = popReturn && document.contains(popReturn) ? popReturn : popReturnSel && $(popReturnSel);
  if (b) b.focus(); else $("#main").focus();
}
function closePops() {
  let any = false;
  ["#states", "#menu"].forEach((s) => { const p = $(s); if (!p.hidden) { p.hidden = true; any = true; } });
  $$('[aria-expanded="true"][data-states], [aria-expanded="true"][data-menu]').forEach((b) => b.setAttribute("aria-expanded", "false"));
  return any;
}
function placePop(pop, btn, o) {
  const b = btn.getBoundingClientRect();
  pop.hidden = false;
  const w = pop.offsetWidth, h = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let x = o && o.side ? b.right + 8 : b.right - w, y = o && o.side ? Math.min(b.top, vh - h - 8) : b.bottom + 4;
  if (o && o.side && x + w > vw - 8) { x = Math.max(8, vw - w - 8); y = b.bottom + 4; }
  if (y + h > vh - 8) y = Math.max(8, b.top - h - 4);
  pop.style.left = Math.max(8, Math.min(x, vw - w - 8)) + "px";
  pop.style.top = Math.max(8, y) + "px";
}
const STATE_LINKS = () => {
  const id = (label) => { const r = RUNS.find((x) => x.label === label); return r ? r.id : ""; };
  const step = (runLabel, stepLabel, pick) => { const r = RUNS.find((x) => x.label === runLabel); if (!r) return ""; const ns = r.flat.filter((n) => n.label === stepLabel && !isGroup(n)); const n = pick === "last" ? ns[ns.length - 1] : ns[0]; return n ? n.id : ""; };
  return [
    ["Global", [
      ["Normal, sample data", "#/runs?state=normal"],
      ["sous service down", "#/runs?state=down"],
      ["sous home empty, first run ever", "#/runs?state=first"],
      ["Loading on first open", "#/runs?state=loading"],
      ["Loading, the graph", "#/runs/r-3n7p5v?view=graph&state=loading"],
      ["Loading, a workflow", "#/workflows/ticket?state=loading"],
      ["Loading, an agent", "#/agents/reviewer?state=loading"],
      ["Loading, a skill", "#/skills/tdd?state=loading"],
      ["Loading, an MCP server", "#/mcp/postgres?state=loading"],
      ["Loading, the start form", "#/runs/new/ticket?state=loading"],
      ["Connection lost, then back", "#/runs?state=lost"],
    ]],
    ["Runs list", [
      ["Empty, with the start call", "#/runs?state=noruns"],
      ["200 runs across 6 projects", "#/runs?state=many"],
      ["Very long names and labels", "#/runs/" + id("Backfill every failed webhook event since the March outage, then move the handlers to the new queue")],
      ["A run with 3 questions waiting", "#/runs/" + id("team PAY") + "?view=graph"],
      ["Filter by project, no match", "#/runs?project=mobile"],
    ]],
    ["Run page", [
      ["Running, live feed", "#/runs/" + id("Dark mode for the pricing page") + "?step=" + step("Dark mode for the pricing page", "address review")],
      ["Question, typed answer", "#/runs/" + id("Add a --json flag to sous list")],
      ["Question, pick one", "#/runs/r-2c8f1d"],
      ["Question, yes or no", "#/runs/r-9h3t6e"],
      ["Breakpoint", "#/runs/" + id("since v2.3.0")],
      ["Failed, with resume", "#/runs/" + id("engine: parallel resumes after a pause") + "?step=" + step("engine: parallel resumes after a pause", "verify")],
      ["Paused for budget", "#/runs/" + id("scope minor")],
      ["Paused for time limit", "#/runs/" + id("search: results update after typing stops")],
      ["Paused for usage limit", "#/runs/r-4b2c7m"],
      ["Stopped", "#/runs/" + id("since v1.8.0")],
      ["Done", "#/runs/" + id("Fix broken links in the guide")],
      ["Nested workflow inside", "#/runs/" + id("team BILL, nightly") + "?view=graph"],
      ["Parallel branches, one failed", "#/runs/" + id("PR 520") + "?view=graph"],
      ["Gate on attempt 3 of 3", "#/runs/" + id("Show the queue position in sous status")],
      ["Very long activity, 500 lines", "#/runs/" + id("Move the tests to vitest 4") + "?step=" + step("Move the tests to vitest 4", "implementer")],
      ["Step with no activity yet", "#/runs/" + id("PR 418") + "?step=" + step("PR 418", "security")],
      ["Tell sent, not read yet", "#/runs/" + id("PR 418") + "?step=" + step("PR 418", "reviewer")],
      ["Graph did not load", "#/runs/r-3n7p5v?view=graph&state=grapherr"],
      ["Activity did not load", "#/runs/" + id("Dark mode for the pricing page") + "?step=" + step("Dark mode for the pricing page", "address review") + "&state=feederr"],
    ]],
    ["Workflows", [
      ["Empty, how to make one", "#/workflows?state=nowf"],
      ["Changed since you approved", "#/workflows/release-notes?view=diff"],
      ["Check problems", "#/workflows/factory"],
      ["People-only workflow", "#/workflows/triage-bugs"],
      ["Very long file", "#/workflows/release-train?view=source"],
      ["Nested workflows", "#/workflows/factory?view=steps"],
      ["No runs yet", "#/workflows/release-train"],
      ["Graph did not load", "#/workflows/ticket?state=grapherr"],
    ]],
    ["Agents, skills, MCP", [
      ["Empty folder", "#/agents?state=noagents"],
      ["Same name hidden in two places", "#/agents/reviewer?from=orchestrator"],
      ["A harness missing a skill", "#/skills/security-review"],
      ["MCP server with secrets masked", "#/mcp/postgres?from=billing"],
      ["Very long prompt", "#/agents/architect"],
      ["Search with no match", "#/agents?search=deploy"],
    ]],
    ["Start a workflow", [
      ["Inputs with defaults and required", "#/runs/new/ticket"],
      ["A validation error", "#/runs/new/ticket?tried=1"],
      ["Changed since you approved", "#/runs/new/release-notes"],
      ["Blocked by a check problem", "#/runs/new/factory"],
      ["People-only, started by you", "#/runs/new/triage-bugs"],
    ]],
  ];
};
function renderStates() {
  const cur = location.hash;
  $("#states").innerHTML = '<div class="top"><h2 id="st-h">States</h2><span class="hint">from states.md</span></div>' +
    STATE_LINKS().map(([g, items]) => '<div class="mh">' + esc(g) + "</div>" + items.map(([l, h]) => '<a class="mi' + (h === cur ? " cur" : "") + '" href="' + h + '">' + esc(l) + "</a>").join("")).join("");
  $("#states").setAttribute("role", "navigation");
  $("#states").setAttribute("aria-labelledby", "st-h");
}

/* ------------------------------------------------------------------ bars: service down, connection lost then back */
let barTimer = null;
function startBars() {
  clearInterval(barTimer);
  const bar = $("#bar");
  if (!bar.sized && window.ResizeObserver) { bar.sized = true; new ResizeObserver(() => document.documentElement.style.setProperty("--barh", (bar.hidden ? 0 : bar.offsetHeight) + "px")).observe(bar); }
  const show = (cls, html) => { bar.className = "bar " + cls; bar.innerHTML = html; bar.hidden = false; document.body.classList.add("has-bar"); bar.setAttribute("role", "status"); };
  const hide = () => { bar.hidden = true; document.body.classList.remove("has-bar"); };
  if (ui.mode === "down") return show("down", ic("warn") + '<span class="grow">The sous service is not running, so no run moves on.</span>' + cmdBox("sous daemon start"));
  if (ui.mode === "lost") {
    let left = 6;
    const draw = () => show("lost", ic("warn") + '<span class="grow">Lost the connection to sous serve. Trying again in ' + left + "s.</span>" + '<button class="btn sm" data-reconnect>Try now</button>');
    draw();
    barTimer = setInterval(() => {
      left--;
      if (left > 0) { const g = $(".grow", bar); if (g) g.textContent = "Lost the connection to sous serve. Trying again in " + left + "s."; return; }
      clearInterval(barTimer);
      show("back", ic("ok") + '<span class="grow">Connected to sous serve again. The page shows the latest state.</span>');
      barTimer = setTimeout(hide, 4000);
    }, 1000);
    return;
  }
  hide();
}

/* ------------------------------------------------------------------ tooltip, with a name */
let tipFor = null;
function showTip(el) {
  const t = $("#tip"), text = el.getAttribute("data-tip");
  if (!text) return;
  tipFor = el;
  t.textContent = text;
  t.hidden = false;
  const b = el.getBoundingClientRect();
  const w = t.offsetWidth, h = t.offsetHeight;
  let x = el.closest(".rail") && window.innerWidth >= 700 ? b.right + 8 : b.left + b.width / 2 - w / 2;
  let y = el.closest(".rail") && window.innerWidth >= 700 ? b.top + b.height / 2 - h / 2 : b.bottom + 6;
  if (y + h > window.innerHeight - 4) y = b.top - h - 6;
  t.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
  t.style.top = Math.max(4, y) + "px";
  el.setAttribute("aria-describedby", "tip");
}
function hideTip() { const t = $("#tip"); t.hidden = true; if (tipFor) tipFor.removeAttribute("aria-describedby"); tipFor = null; }

/* ------------------------------------------------------------------ dialog */
let dlgReturn = null;
function openDialog(html, label) {
  const d = $("#dlg");
  dlgReturn = document.activeElement;
  d.innerHTML = '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-h">' + html + "</div>";
  d.hidden = false;
  $("#app").inert = true;
  const f = $("[data-autofocus]", d) || $("button", d);
  if (f) f.focus();
}
function closeDialog() {
  const d = $("#dlg");
  if (d.hidden) return false;
  d.hidden = true; d.innerHTML = "";
  $("#app").inert = !$("#search").hidden;
  if (dlgReturn && document.contains(dlgReturn)) dlgReturn.focus();
  return true;
}
function copyText(text) {
  try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e) { /* clipboard may be off on file urls */ }
  toast("Copied", text);
}
