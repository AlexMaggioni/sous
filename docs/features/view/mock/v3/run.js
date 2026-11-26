/* sous view mock v3: the run page. Header, needs-you panel, Steps view on a time axis, step details, graph, live updates. */
"use strict";

const OPEN_RUN = (r) => ["running", "question", "breakpoint"].includes(r.status);
const runEnd = (r) => r.endedAt || r.pausedAt || Date.now();
const runElapsed = (r) => runEnd(r) - r.startedAt;
function leavesOf(n) { return isGroup(n) ? n.kids.reduce((a, c) => a.concat(leavesOf(c)), []) : [n]; }
/* the steps both views count: each node the graph draws. A gate or retry is one, a breakpoint is one besides the steps inside it. */
function unitsOf(run) {
  const out = [];
  const walk = (n) => {
    if (!isGroup(n) || n.k === "gate" || n.k === "retry" || !n.kids.length) { out.push(n); return; }
    n.kids.forEach(walk);
    if (n.k === "bp") out.push(n);
  };
  run.tree.kids.forEach(walk);
  return out;
}
const tokOf = (n) => leavesOf(n).reduce((a, x) => a + (x.tok || 0), 0);
function tokSplit(x) { const i = Math.round(x.tok * 0.84); return { i, o: x.tok - i, c: Math.round(x.tok * 2.6) }; }
function costOf(n) {
  return leavesOf(n).reduce((a, x) => {
    if (x.k !== "agent" || !x.tok) return a;
    const pr = PRICE[x.modelName] || PRICE.sonnet, t = tokSplit(x);
    return a + (t.i * pr[0] + t.o * pr[1] + t.c * pr[2]) / 1e6;
  }, 0);
}
/* A resume after a stop or a pause leaves an idle gap. actOf maps a time since the start to working time, without the gaps. */
const actOf = (run, t) => (run.gaps || []).reduce((a, g) => a - Math.max(0, Math.min(g.len, t - g.at)), t);
const actElapsed = (run) => actOf(run, runElapsed(run));
const durOf = (n) => n.start == null ? null : actOf(n.run, n.end != null ? n.end : runElapsed(n.run)) - actOf(n.run, n.start);
const isLive = (n) => n.start != null && n.end == null && OPEN_RUN(n.run);
const fmtTick = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + (s % 60 ? " " + pad2(s % 60) + "s" : "");
  return Math.floor(m / 60) + "h" + (m % 60 ? " " + pad2(m % 60) + "m" : "");
};
const STATUS_TEXT = (r) => ({ question: "Needs you", breakpoint: "Waiting at a breakpoint", running: "Running", paused: "Paused", failed: "Failed", stopped: "Stopped", done: "Done" })[r.status];
const PAUSE_TEXT = { usage_limit: "usage limit", budget: "budget", auth_required: "not logged in", time_limit: "time limit" };

/* ------------------------------------------------------------------ names */
function nodeSub(n) {
  switch (n.k) {
    case "agent": return n.agent + ", " + n.modelName;
    case "sh": case "js": case "py": case "run": return n.cmd || "";
    case "ask": case "checkpoint": case "choose": return KIND_NAME[n.k];
    case "gate": case "retry": return KIND_NAME[n.k] + (n.kids.length ? ", attempt " + n.kids.length + " of " + n.max : ", up to " + plural(n.max, "attempt"));
    case "attempt": return n.verdict || (n.status === "running" || n.status === "waiting" ? "running now" : "");
    case "par": return "parallel, " + plural(n.kids.length, "branch", "branches");
    case "pipe": return "pipeline, " + plural(n.kids.length, "item");
    case "lane": return "pipeline item";
    case "wf": return "workflow " + n.wf;
    case "bp": return "breakpoint";
  }
  return "";
}
const pathOf = (n) => { const out = []; let p = n.parent; while (p && p.k !== "root") { if (p.k !== "attempt") out.unshift(p.label); p = p.parent; } return out; };

/* ------------------------------------------------------------------ status changes from the page */
function restatus(n) {
  if (!isGroup(n)) return n.status;
  const ks = n.kids.map(restatus);
  let s;
  if (n.k === "attempt" && n.ok === false && !ks.some((x) => x === "running" || x === "waiting")) s = "failed";
  else if (n.k === "bp" && n.s && n.s !== "waiting") s = n.s === "approved" ? "done" : n.s;
  else if (!ks.length) s = n.status;
  else if (ks.includes("waiting")) s = "waiting";
  else if (ks.includes("running")) s = "running";
  else if (ks.includes("paused")) s = "paused";
  else if (ks.every((x) => x === "queued")) s = "queued";
  else if (ks.includes("failed") && n.k !== "par" && n.k !== "gate" && n.k !== "retry") s = "failed";
  else if (ks.includes("stopped")) s = "stopped";
  else s = n.status === "waiting" || n.status === "running" ? "running" : n.status;
  n.status = s;
  return s;
}
function settle(run) {
  restatus(run.tree);
  run.asks = run.flat.filter((n) => n.ask && n.status === "waiting").map((n) => Object.assign({ node: n }, n.ask));
  if (run.status === "question" || run.status === "breakpoint") run.status = run.asks.length ? (run.asks.some((a) => a.kind === "breakpoint") ? "breakpoint" : "question") : "running";
}
function answerAsk(run, n, text, how) {
  const at = runElapsed(run), id = (n.ask || {}).id;
  if (n.k === "agent") { n.acts.push({ k: "answer", t: text, at: Date.now() }); n.status = "running"; n.end = null; }
  else if (n.k === "bp") { n.s = how === "send-back" ? "waiting" : "approved"; n.status = how === "send-back" ? "running" : "done"; if (how !== "send-back") { n.waitedFrom = n.askedAt; n.waited = at - (n.askedAt != null ? n.askedAt : n.start || 0); n.end = at; } }
  else { n.answer = text; n.by = "you, from this view"; n.status = "done"; n.end = at; }
  const cmd = how === "approve" ? "sous approve " + id : how === "send-back" ? "sous send-back " + id + " " + shq(text) : "sous answer " + id + " " + shq(text);
  ui.answered[run.id + n.id] = { text, how, cmd, at: Date.now(), q: n.k === "agent" ? n.label : '"' + n.label + '"' };
  settle(run);
  return cmd;
}
function stopRun(run) {
  const at = runElapsed(run);
  run.flat.forEach((n) => {
    if (isGroup(n)) return;
    if (n.status === "running" || n.status === "waiting") { n.status = "stopped"; n.end = at; }
    else if (n.status === "queued") n.status = "skipped";
  });
  run.status = "stopped"; run.endedAt = Date.now(); run.asks = [];
  restatus(run.tree);
}
function resumeRun(run, from) {
  const stopAt = run.endedAt || run.pausedAt;
  if (stopAt && Date.now() - stopAt > 1000) (run.gaps = run.gaps || []).push({ at: stopAt - run.startedAt, len: Date.now() - stopAt });
  delete run.pausedAt; delete run.endedAt; run.pause = null; run.notice = null;
  const now = runElapsed(run);
  run.flat.forEach((n) => {
    if (isGroup(n)) return;
    if (n === from || (!from && (n.status === "paused" || n.status === "failed"))) {
      if (n.tries) n.tries.push({ s: "running", start: now });
      n.status = "running"; n.start = now; n.end = null; n.exit = null; n.err = null; n.stderr = null;
    }
  });
  run.status = "running";
  restatus(run.tree);
}

/* ------------------------------------------------------------------ run page */
function runPage(run, p) {
  const view = p.view === "graph" ? "graph" : "steps";
  const sel = p.step && run.flat.some((n) => n.id === p.step) ? p.step : null;
  if (sel) { let x = run.flat.find((n) => n.id === sel).parent; while (x) { ui.fold[run.id + ":" + x.id] = false; x = x.parent; } }
  const open = OPEN_RUN(run);
  const st = runIcon(run);
  const status = '<span class="st' + (needsYou(run) ? " needs" : "") + '" id="run-status" tabindex="-1">' + si(st, false) + esc(STATUS_TEXT(run)) + (run.pause ? ", " + esc(PAUSE_TEXT[run.pause.reason]) : "") + "</span>";
  let primary = "";
  /* A failed run names the step it resumes from. While that step is open, its own "Resume from here" is the only one. */
  const openN = view === "steps" && ui.route.params.step ? nodeById(run, ui.route.params.step) : null;
  const stepResume = run.status === "failed" && openN && !isGroup(openN) && openN.status === "failed";
  const failedN = run.status === "failed" ? run.flat.filter((n) => !isGroup(n) && n.status === "failed") : [];
  if (failedN.length === 1 && !stepResume) primary = '<button class="btn primary" data-act="resume-step" data-node="' + failedN[0].id + '"' + downAttr() + ">" + I.play + "Resume from " + esc(failedN[0].label) + "</button>";
  else if (run.status === "paused" || (run.status === "failed" && !stepResume)) primary = '<button class="btn primary" data-act="resume"' + downAttr() + ">" + I.play + "Resume</button>";
  const stop = open || run.status === "paused" ? '<button class="btn quiet" data-act="stop"' + downAttr() + ">" + I.stop + "Stop</button>" : "";
  const more = '<button class="ibtn bd" data-menu="run" aria-haspopup="true" aria-expanded="false" aria-label="More actions" data-tip="More">' + I.more + "</button>";
  const live = (t) => open ? ' data-live-dur="' + t + '"' : "";
  const act = actElapsed(run);
  const pairs = [
    ["Project", esc(run.project), true],
    ["Started", timeEl(run.startedAt)],
    run.endedAt ? ["Finished", timeEl(run.endedAt)] : run.pausedAt ? ["Paused", timeEl(run.pausedAt)] : null,
    ["Duration", "<span" + live(Date.now() - act) + ">" + fmtDur(act) + "</span>"],
    ["Tokens", '<span data-run-tok>' + fmtTok(tokOf(run.tree)) + "</span>"],
    ["Cost", '<span data-run-cost>' + fmtCost(costOf(run.tree)) + "</span>"],
  ];
  const all = unitsOf(run), done = all.filter((n) => n.status === "done").length;
  return '<div class="page run">' + crumbs([["Runs", "#/runs"], [run.project, "#/runs?project=" + enc(run.project)], [run.id]]) +
    '<div class="head"><div class="grow"><div class="idline tline"><h1 class="title">' + esc(run.wf) + "</h1>" +
    '<span class="id"><code>' + esc(run.id) + '</code><button class="copy" data-copy="' + esc(run.id) + '" aria-label="Copy the run id">' + I.copy + "</button></span>" + status + "</div>" +
    '<p class="subline">' + esc(run.label) + "</p></div>" +
    '<div class="actions">' + stop + primary + more + "</div></div>" +
    '<dl class="pairs run-pairs">' + pairs.filter(Boolean).map(([k, v, sans]) => "<div><dt>" + k + "</dt><dd" + (sans ? ' class="sans"' : "") + ">" + v + "</dd></div>").join("") + "</dl>" +
    runNotice(run) + answeredNotes(run) + needsPanel(run) +
    (run.result ? '<section class="result" aria-labelledby="res-h"><h2 id="res-h" class="hint">Result</h2><p>' + esc(run.result) + "</p></section>" : "") +
    '<div class="viewbar"><nav class="seg" aria-label="View">' + [["steps", "Steps"], ["graph", "Graph"]].map(([k, l]) =>
      '<a href="#/runs/' + enc(run.id) + (k === "graph" ? "?view=graph" : "") + '"' + (view === k ? ' aria-current="page"' : "") + ">" + l + "</a>").join("") + "</nav>" +
    '<span class="r">' + done + " of " + plural(all.length, "step") + " done</span></div>" +
    (view === "graph" ? runGraph(run, sel) : stepsView(run, sel)) + aboutRun(run) + "</div>";
}
function crumbs(items) {
  return '<nav class="crumbs" aria-label="Breadcrumb"><button class="btn sm col-btn" data-col aria-expanded="' + ui.colOpen + '">' + I.list + "List</button>" +
    items.map(([l, h], i) => (i ? '<span aria-hidden="true">/</span>' : "") + (h ? '<a href="' + h + '">' + esc(l) + "</a>" : '<span class="' + (/^r-|^q-/.test(l) ? "mono" : "") + '" aria-current="page">' + esc(l) + "</span>")).join("") + "</nav>";
}
function runNotice(run) {
  const note = (cls, icon, text, cmd) => '<div class="note ' + cls + '">' + ic(icon) + '<div class="grow">' + text + (cmd ? '<div class="cmd-wrap">' + cmdBox(cmd) + "</div>" : "") + "</div></div>";
  let out = "";
  if (run.pause) {
    const p = run.pause;
    if (p.reason === "usage_limit") out += note("pause", "pause", "Paused at the usage limit of the account default. sous resumes it " + timeEl(p.resumesAt) + ", when the limit resets. To go on sooner, switch the account with sous account, then resume.", "sous resume " + run.id);
    if (p.reason === "budget") out += note("pause", "pause", "Paused at its budget of " + fmtTok(p.budget) + " tokens. The zod item stopped there. Resume with a larger budget.", "sous resume " + run.id + " --budget 400k");
    if (p.reason === "auth_required") out += note("pause", "pause", "Paused because Claude Code is not logged in. Run claude and log in, then resume.", "sous resume " + run.id);
    if (p.reason === "time_limit") out += note("pause", "pause", "Paused when the workflow's timeout of " + esc(p.limit) + " ran out. Resume starts the stopped step again.", "sous resume " + run.id);
  }
  if (run.notice) {
    const failed = run.status === "failed", n = run.flat.find((x) => !isGroup(x) && x.status === "failed");
    let text = esc(run.notice);
    const re = n && new RegExp("\\b" + esc(n.label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
    if (re && re.test(text)) text = text.replace(re, '<button class="lnk-btn" data-step-go="' + n.id + '">' + esc(n.label) + "</button>");
    out += note(failed ? "fail" : run.status === "done" ? "fail" : "muted-ic", failed ? "warn" : run.status === "done" ? "warn" : "info", text, failed && n ? "sous resume " + run.id + " --step " + shq(n.label) : null);
  }
  return out;
}
function aboutRun(run) {
  const w = WF[run.wf];
  const ins = Object.keys(run.inputs || {});
  return '<section class="sec" aria-labelledby="about-h"><div class="sec-h"><h2 id="about-h">About this run</h2></div><dl class="kv">' +
    "<dt>Workflow</dt><dd>" + (w ? '<a class="lnk" href="#/workflows/' + enc(w.name) + '">' + esc(w.name) + '</a><span class="sub mono">' + esc(w.path) + "</span>" : esc(run.wf)) + "</dd>" +
    "<dt>Started by</dt><dd>" + esc(run.by) + "</dd>" +
    "<dt>Inputs</dt><dd>" + (ins.length ? ins.map((k) => "<code>" + esc(k) + "</code> " + esc(JSON.stringify(run.inputs[k]))).join("<br>") : "none") + "</dd>" +
    "<dt>In a terminal</dt><dd>" + cmdBox("sous show " + run.id) + "</dd></dl></section>";
}

/* ------------------------------------------------------------------ needs you */
function needsPanel(run) {
  const asks = (run.asks || []).filter((a) => !ui.answered[run.id + a.node.id]);
  if (!asks.length) return "";
  const down = ui.mode === "down" ? '<div class="note fail down-note">' + ic("warn") + '<div class="grow">The sous service is not running, so sous cannot take an answer now. Start it, then answer.<div class="cmd-wrap">' + cmdBox("sous daemon start") + "</div></div></div>" : "";
  if (asks.length === 1) return '<section class="needs-p" id="needs" aria-labelledby="ask-' + asks[0].node.id + '">' + askItem(run, asks[0], true) + down + "</section>";
  return '<section class="needs-p" id="needs" aria-labelledby="needs-h"><h2 id="needs-h">' + asks.length + " questions wait for you</h2>" +
    asks.map((a) => '<div class="item">' + askItem(run, a, false) + "</div>").join("") + down + "</section>";
}
/* what you answered stays on the page, where the question was */
function answeredNotes(run) {
  return run.flat.filter((n) => ui.answered[run.id + n.id]).map((n) => {
    const a = ui.answered[run.id + n.id];
    const what = a.how === "approve" ? "You approved " + esc(a.q) + " " + timeEl(a.at) + "."
      : a.how === "send-back" ? "You sent " + esc(a.q) + " back " + timeEl(a.at) + ' with "' + esc(a.text) + '". The steps inside run again.'
      : "You answered " + esc(a.q) + " " + timeEl(a.at) + ': "' + esc(a.text) + '". ' + (n.k === "agent" ? esc(n.label) + " goes on in the same session." : "The run goes on.");
    return '<div class="note answered">' + ic("ok") + '<div class="grow">' + what + ' <button class="lnk-btn" data-step-go="' + n.id + '">Show the step</button><div class="cmd-wrap">' + cmdBox(a.cmd) + "</div></div></div>";
  }).join("");
}
/* the agent's work before the question, in one dim line that opens */
function askContext(run, n) {
  let ag = n.k === "agent" ? n : null;
  if (!ag) {
    const pool = n.k === "bp" ? leavesOf(n) : run.flat.slice(0, run.flat.indexOf(n));
    for (let i = pool.length - 1; i >= 0 && !ag; i--) if (pool[i].k === "agent" && pool[i].acts && pool[i].acts.length) ag = pool[i];
  }
  if (!ag) return "";
  const acts = (ag.acts || []).filter((a) => a.k !== "prompt" && a.k !== "asks");
  const tools = acts.filter((a) => a.k === "tool");
  const times = (k) => k === 1 ? "once" : k === 2 ? "twice" : k + " times";
  const uniq = (xs) => xs.filter((x, i) => xs.indexOf(x) === i);
  const bits = [];
  const reads = uniq(tools.filter((a) => a.n === "Read").map((a) => a.a));
  if (reads.length) bits.push("read " + plural(reads.length, "file"));
  const grep = tools.filter((a) => a.n === "Grep" || a.n === "Glob").length;
  if (grep) bits.push("searched " + times(grep));
  const edits = uniq(tools.filter((a) => /^(Edit|Write|apply_patch)$/.test(a.n)).map((a) => a.a));
  if (edits.length) bits.push("edited " + plural(edits.length, "file"));
  const cmds = tools.filter((a) => a.n === "Bash" || a.n === "shell").map((a) => a.a.split(" ").slice(0, 3).join(" "));
  if (cmds.length) bits.push(uniq(cmds).length === 1 ? "ran " + cmds[0] + " " + times(cmds.length) : "ran " + plural(cmds.length, "command"));
  const mcp = {};
  tools.filter((a) => /^mcp /.test(a.n)).forEach((a) => { const k = a.n.slice(4); mcp[k] = (mcp[k] || 0) + 1; });
  Object.keys(mcp).forEach((k) => bits.push("called " + k + " " + times(mcp[k])));
  const until = n.k === "agent" && n.askedAt != null ? n.askedAt - (ag.start || 0) : durOf(ag);
  const who = ag === n ? "Worked" : esc(ag.label) + " worked";
  const line = who + " for " + fmtDur(until) + (bits.length ? ", " + esc(bits.slice(0, 4).join(", ")) : "");
  stampActs(run, ag);
  const last = acts.slice(-5), msg = acts.filter((a) => a.k === "text").pop();
  const lines = (msg && !last.includes(msg) ? [msg] : []).concat(last);
  return '<details class="fold ctx"><summary><span class="chev">' + I.chev + "</span>" + line + '</summary><div class="in acts-list">' + lines.map(actLine).join("") + "</div></details>";
}
function askItem(run, a, single) {
  const n = a.node, since = run.startedAt + (n.askedAt != null ? n.askedAt : n.start || 0);
  const who = a.kind === "input" ? n.agent + " asks" : a.kind === "breakpoint" ? "Breakpoint" : a.kind === "confirm" ? "Checkpoint" : "Question";
  const where = pathOf(n).concat(n.k === "bp" ? [] : [n.label]).join(" / ");
  const head = '<div class="from">' + si("waiting", false) + '<span class="who" id="ask-' + n.id + '">' + esc(who) + "</span>" + (where ? '<span>step <button class="lnk-btn" data-step-go="' + n.id + '">' + esc(where) + "</button></span>" : "") +
    '<code>' + esc(a.id) + "</code><span>asked " + timeEl(since) + "</span></div>";
  const fid = "ans-" + n.id, off = downAttr();
  let ctl = "", cmd = "";
  if (a.kind === "input") {
    ctl = '<form class="ctl" data-answer="' + n.id + '"><label class="vh" for="' + fid + '">Your answer to ' + esc(n.agent) + '</label><textarea id="' + fid + '" placeholder="Your answer goes back to the same session"></textarea>' +
      '<button class="btn' + (single ? " primary" : "") + '" type="submit"' + off + ">Send answer</button></form>";
    cmd = "sous answer " + a.id + ' "your answer"';
  } else if (a.kind === "select") {
    ctl = '<form data-answer="' + n.id + '"><fieldset class="choices" aria-label="' + esc(a.text) + '">' + a.choices.map((c, i) =>
      '<label><input type="radio" name="' + fid + '" value="' + esc(c) + '"' + (i === 0 ? " checked" : "") + ">" + esc(c) + "</label>").join("") + "</fieldset>" +
      '<div class="ctl"><button class="btn' + (single ? " primary" : "") + '" type="submit"' + off + ">Send answer</button></div></form>";
    cmd = "sous answer " + a.id + " " + shq(a.choices[0]);
  } else if (a.kind === "confirm") {
    ctl = '<div class="ctl"><button class="btn' + (single ? " primary" : "") + '" data-answer-btn="' + n.id + '" data-v="Yes"' + off + '>Yes</button><button class="btn" data-answer-btn="' + n.id + '" data-v="No"' + off + ">No</button></div>";
    cmd = "sous answer " + a.id + " " + shq("Yes");
  } else if (a.kind === "breakpoint") {
    const doc = n.show || "";
    ctl = '<div class="bpdoc">' + mdBlock("bp:" + run.id + n.id, doc, { label: "What the steps before it made" }).replace(/^<div class="mdblk">|<\/div>$/g, "") + "</div>" +
      '<div class="ctl"><button class="btn' + (single ? " primary" : "") + '" data-answer-btn="' + n.id + '" data-v="approve"' + off + ">Approve</button>" +
      '<button class="btn" data-act="sendback-open" data-node="' + n.id + '" aria-expanded="' + !!ui.lookOpen["sb" + run.id + n.id] + '">Send back</button></div>' +
      (ui.lookOpen["sb" + run.id + n.id] ? '<form class="sendback" data-sendback="' + n.id + '"><label for="sb-' + n.id + '">What should change? The steps inside run again with your note.</label><textarea id="sb-' + n.id + '"></textarea><div class="ctl"><button class="btn" type="submit"' + off + ">Send back</button></div></form>" : "");
    cmd = "sous approve " + a.id;
  }
  return head + '<p class="q">' + esc(a.text) + "</p>" + (a.detail ? '<p class="detail">' + esc(a.detail) + "</p>" : "") +
    (a.kind === "input" ? '<p class="detail">The agent waits in its session. Your answer goes back to the same session.</p>' : "") +
    askContext(run, n) + ctl + '<p class="hint">Or from a terminal: ' + cmdBox(cmd) + "</p>";
}

/* ------------------------------------------------------------------ Steps view: rows on a time axis */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);
function axisFor(run) {
  const open = OPEN_RUN(run);
  const span = Math.max(1000, open ? actElapsed(run) : (run.span || actElapsed(run)));
  let end = open ? span * 1.15 : span;
  const step = TICK_STEPS.find((t) => end / t <= 5) || TICK_STEPS[TICK_STEPS.length - 1];
  if (open) end = Math.ceil(end / step) * step;
  return { end, step, open };
}
const pct = (v) => (Math.round(v * 1000) / 1000) + "%";
function ticks(ax) { let h = ""; for (let t = ax.step; t < ax.end - 1; t += ax.step) h += '<span class="tk" style="left:' + pct(t / ax.end * 100) + '"></span>'; return h; }
function foldedIn(run, n) {
  const k = run.id + ":" + n.id;
  if (k in ui.fold) return ui.fold[k];
  if (n.k === "attempt") { const sib = n.parent.kids; return n !== sib[sib.length - 1]; }
  return false;
}
function stepRows(run) {
  const rows = [];
  const walk = (n, depth) => { rows.push({ n, depth }); if (isGroup(n) && !foldedIn(run, n)) n.kids.forEach((c) => walk(c, depth + 1)); };
  run.tree.kids.forEach((c) => walk(c, 0));
  return rows;
}
function stepsView(run, sel) {
  const ax = axisFor(run);
  const el = actElapsed(run);
  const axis = '<div class="srow axis" aria-hidden="true"><div class="scell"><span class="fill">Step</span><span class="dur">Duration</span></div><div class="tcell">' + ticks(ax) +
    '<span class="tl first">0s</span>' + (() => { let h = ""; for (let t = ax.step; t < ax.end - 1; t += ax.step) if (ax.end - t > ax.step * 0.45 || ax.open) h += '<span class="tl" style="left:' + pct(t / ax.end * 100) + '">' + fmtTick(t) + "</span>"; return h; })() + "</div></div>";
  const rows = stepRows(run).map(({ n, depth }) => stepRow(run, n, depth, ax, sel) + (sel === n.id ? stepDrop(run, n) : "")).join("");
  const now = ax.open ? '<div class="nowline" aria-hidden="true"><span class="nowlbl">now</span></div>' : "";
  const idle = (run.gaps || []).map((g) => '<div class="gapline" aria-hidden="true" style="--at:' + (actOf(run, g.at) / ax.end).toFixed(4) + '"><span class="gaplbl">' + fmtDur(g.len) + " idle</span></div>").join("");
  return '<div class="steps" id="steps" data-axis-end="' + ax.end + '" style="--now:' + (el / ax.end).toFixed(4) + '">' + axis + rows + idle + now + "</div>";
}
function stepRow(run, n, depth, ax, sel) {
  const grp = isGroup(n) && n.kids.length > 0, fold = grp && foldedIn(run, n), open = sel === n.id;
  const gd = '<span class="gd" aria-hidden="true"></span>'.repeat(depth);
  /* a group's chevron shows the steps inside; a single step's chevron, inside its button, shows its details */
  const foldBtn = grp ? '<button class="fold" data-fold="' + n.id + '" aria-expanded="' + !fold + '" aria-label="' + (fold ? "Show" : "Hide") + " the steps inside " + esc(n.label) + '"><span class="chev' + (fold ? "" : " o") + '">' + I.chev + "</span></button>" : "";
  const openChev = grp ? "" : '<span class="fold" aria-hidden="true"><span class="chev' + (open ? " o" : "") + '">' + I.chev + "</span></span>";
  const d = durOf(n), live = isLive(n);
  const durTxt = n.status === "queued" ? "" : n.status === "skipped" ? "skipped" : fmtDur(d);
  const name = n.k === "bp" ? n.label : n.label;
  const cell = '<div class="scell">' + gd + foldBtn + '<button class="sbtn" data-step="' + n.id + '" aria-expanded="' + open + '"' + (open ? ' aria-controls="drop-' + n.id + '"' : "") + ">" + openChev +
    si(n.status, ST_LABEL[n.status]) + '<span class="nm">' + esc(name) + '</span><span class="nm2">' + esc(nodeSub(n)) + "</span>" +
    '<span class="dur"' + (live ? ' data-live-dur="' + (Date.now() - d) + '"' : "") + ">" + esc(durTxt) + "</span></button></div>";
  let bar = "";
  if (n.start != null) {
    const s0 = actOf(run, n.start), endOff = actOf(run, n.end != null ? n.end : runElapsed(run));
    const cls = "sbar " + n.status + (isGroup(n) ? " grp" : "") + (live ? " open" : "");
    bar = '<span class="' + cls + '" style="left:min(' + pct(s0 / ax.end * 100) + ", calc(100% - 3px));width:" + pct(Math.max(0, endOff - s0) / ax.end * 100) + '"' + (live ? ' data-bar="' + s0 + '"' : "") + "></span>";
    if (n.q) bar = '<span class="qw" style="left:' + pct((s0 - n.q) / ax.end * 100) + ";width:" + pct(n.q / ax.end * 100) + '"></span>' + bar;
  }
  return '<div class="srow' + (open ? " open" : "") + (n.status === "waiting" ? " waiting" : "") + '">' + cell + '<div class="tcell" aria-hidden="true">' + ticks(ax) + bar + "</div></div>";
}

/* ------------------------------------------------------------------ step details */
function stepDrop(run, n) {
  const abs = (off) => run.startedAt + off;
  const blk = (title, rows) => { const r = rows.filter((x) => x && x[1] != null && x[1] !== ""); return r.length ? '<div class="blk"><h3>' + title + '</h3><dl class="kv">' + r.map(([k, v, sans]) => "<dt>" + esc(k) + "</dt><dd" + (sans ? ' class="sans"' : "") + ">" + v + "</dd>").join("") + "</dl></div>" : ""; };
  const live = isLive(n);
  const kindTxt = n.k === "agent" ? "agent step" : ["sh", "js", "py", "run"].includes(n.k) ? n.k + ", a code step" : KIND_NAME[n.k] || n.k;
  const stepRows = [["Kind", esc(kindTxt), true], ["Status", '<span class="st">' + si(n.status, false) + esc(ST_LABEL[n.status] || n.status) + "</span>", true]];
  if (n.k === "agent") {
    stepRows.push(["Agent", '<a class="lnk" href="#/agents/' + enc(n.agent) + '">' + esc(n.agent) + "</a>", true], ["Runs on", esc(n.harness), true], ["Model", esc(n.modelName)], ["Effort", n.effort ? esc(n.effort) : "default"]);
    if (n.session) stepRows.push(["Session", esc(n.session) + (n.cont ? '<span class="sub">goes on from implementer</span>' : "")]);
    if (n.mcp) stepRows.push(["MCP", n.mcp.map((m) => '<a class="lnk" href="#/mcp/' + enc(m) + '">' + esc(m) + "</a>").join(", "), true]);
  }
  if (n.exit != null || (n.tries && n.tries.length && n.status !== "running")) stepRows.push(["Exit code", esc(n.exit != null ? n.exit : 0)]);
  if (n.retries) stepRows.push(["Retries", esc(n.retries) + '<span class="sub">so up to ' + (n.retries + 1) + " tries before it fails</span>"]);
  if (n.k === "gate" || n.k === "retry") stepRows.push(["Attempts", esc(n.kids.length + " of " + n.max), true]);
  if (n.k === "wf") stepRows.push(["Workflow", '<a class="lnk" href="#/workflows/' + enc(n.wf) + '">' + esc(n.wf) + "</a>", true]);
  const timeRows = [
    n.q ? ["Waited for a slot", esc(fmtDur(n.q))] : null,
    ["Started", n.start != null ? timeEl(abs(n.start)) : "not yet", n.start == null],
    n.status === "waiting" && n.askedAt != null ? ["Asked", timeEl(abs(n.askedAt))] : null,
    n.end != null ? ["Finished", timeEl(abs(n.end))] : null,
    n.start != null ? ["Duration", "<span" + (live ? ' data-live-dur="' + (Date.now() - durOf(n)) + '"' : "") + ">" + esc(fmtDur(durOf(n))) + "</span>"] : null,
  ];
  let tokBlk = "";
  if (n.k === "agent" && n.tok != null) { const t = tokSplit(n); tokBlk = blk("Tokens", [["Input", fmtTok(t.i)], ["Output", fmtTok(t.o)], ["Cache read", fmtTok(t.c)], ["Cost", fmtCost(costOf(n))]]); }
  else if (isGroup(n) && tokOf(n)) tokBlk = blk("Tokens", [["All steps", fmtTok(tokOf(n))], ["Cost", fmtCost(costOf(n))]]);
  const part = (title, body, right) => '<div class="part"><div class="ph"><h3>' + title + "</h3>" + (right ? '<span class="r">' + right + "</span>" : "") + "</div>" + body + "</div>";
  let parts = "";
  if (n.k === "agent") {
    if (n.prompt && n.status !== "queued") parts += part("Prompt", mdBlock("pr:" + run.id + n.id, n.prompt, { labelHtml: "Sent " + timeEl(abs(n.start || 0)) }));
    if (n.status !== "queued") parts += part("Activity", ui.mode === "feederr" ? feedErr(run, n) : '<div class="acts-list" id="acts-' + n.id + '">' + actsHtml(run, n) + "</div>", n.status === "running" && ui.mode !== "feederr" ? '<span class="hint">updates live</span>' : "");
  }
  if (n.cmd && !n.agent) parts += part("Command", cmdBox(n.cmd));
  if (n.tries && n.tries.length) parts += part("Tries", n.tries.map((t, i) => '<div class="att try"><span class="al' + (t.s === "failed" ? " bad" : "") + '">' + si(t.s, false) + "Try " + (i + 1) + "</span>" +
    (t.s === "running" ? '<span class="ad"' + (live ? ' data-live-dur="' + abs(t.start) + '"' : "") + ">" + fmtDur(runElapsed(run) - t.start) + '</span><span class="av">started ' + timeEl(abs(t.start)) + "</span>"
      : '<span class="ad">' + fmtDur(t.d) + '</span><span class="av">exit ' + t.exit + "</span>") +
    (t.stderr ? '<div class="att-err">' + errHtml(null, t.stderr, "stderr", false) + "</div>" : "") + "</div>").join(""));
  if (n.err && n.status !== "failed") parts += part("Error", errHtml(n.err, n.stderr, "Stack trace"));
  if (n.out) parts += part("Output", /^## /.test(n.out) ? mdBlock("out:" + run.id + n.id, n.out, { label: "Returned text" }) : '<pre class="out" tabindex="0">' + esc(n.out) + "</pre>");
  if (n.ask && n.k !== "agent" && n.k !== "bp") parts += part("Question", '<p class="q">' + esc(n.ask.text) + "</p>" + (n.ask.choices ? '<p class="hint">Choices: ' + esc(n.ask.choices.join(", ")) + "</p>" : "") + (n.answer ? "<p>Answer: <b>" + esc(n.answer) + "</b>" + (n.by ? ", by " + esc(n.by) : "") + "</p>" : ""));
  if (n.k === "bp" && n.show) parts += part("What it showed", mdBlock("bpd:" + run.id + n.id, n.show, { label: "Shown to you" }) + (n.s === "approved" ? '<p class="hint">You approved it after ' + fmtDur(n.waited || 0) + ".</p>" : n.s === "stopped" ? '<p class="hint">You stopped the run here after ' + fmtDur(n.waited || 0) + ".</p>" : ""));
  if (n.k === "gate" || n.k === "retry") parts += part("Attempts", n.kids.length ? n.kids.map((a, i) => '<div class="att"><span class="al' + (a.status === "failed" ? " bad" : "") + '">' + si(a.status, false) + "Attempt " + (i + 1) + '</span><span class="ad">' + fmtDur(durOf(a)) + '</span><span class="av" data-tip="' + esc(a.verdict || "") + '">' + esc(a.verdict || ST_LABEL[a.status]) + "</span></div>").join("") : '<p class="noact">No attempt yet.</p>');
  if (n.k === "par" || n.k === "pipe") parts += part(n.k === "par" ? "Branches" : "Items", n.kids.map((c) => '<div class="att"><span class="al' + (c.status === "failed" ? " bad" : "") + '">' + si(c.status, false) + esc(c.label) + '</span><span class="ad">' + fmtDur(durOf(c)) + '</span><span class="av">' + esc(c.status === "failed" ? "failed. " + (n.k === "par" ? "parallel() gave null for it, and the run went on." : "") : nodeSub(c)) + "</span></div>").join(""));
  if (n.k === "wf") parts += part("Inputs", '<dl class="kv">' + Object.keys(n.inputs).map((k) => "<dt><code>" + esc(k) + "</code></dt><dd>" + esc(JSON.stringify(n.inputs[k])) + "</dd>").join("") + "</dl>");
  let first = "";
  if (n.status === "failed" && !isGroup(n)) {
    const resume = run.status === "failed" ? '<div class="acts"><button class="btn primary" data-act="resume-step" data-node="' + n.id + '"' + downAttr() + ">" + I.play + "Resume from here</button>" + cmdBox("sous resume " + run.id + " --step " + shq(n.label)) + "</div>" : "";
    first = '<div class="failfirst">' + errHtml(n.err || "The step failed.", n.stderr, "Stack trace") + resume + "</div>";
  }
  const acts = [];
  if (n.k === "agent" && n.status === "running") {
    const tr = ui.tellResult[run.id + n.id];
    acts.push('<form class="tellf" data-tell="' + n.id + '"><label class="vh" for="tell-' + n.id + '">Tell ' + esc(n.label) + '</label><input id="tell-' + n.id + '" type="text" placeholder="Tell ' + esc(n.label) + ' something while it works" autocomplete="off"><button class="btn" type="submit"' + downAttr() + ">" + I.tell + "Tell</button></form>" +
      '<button class="btn quiet" data-act="stop-step" data-node="' + n.id + '"' + downAttr() + ">" + I.stop + "Stop this step</button>");
    if (tr) acts.push('<div class="refuse note fail" role="status">' + ic("warn") + '<div class="grow">' + esc(tr) + "</div></div>");
  }
  return '<div class="sdrop" id="drop-' + n.id + '" role="region" aria-label="Details of ' + esc(n.label) + '">' + first + '<div class="grid">' + blk("Step", stepRows) + blk("Time", timeRows) + tokBlk + "</div>" + parts +
    (acts.length ? '<div class="acts">' + acts.join("") + "</div>" : "") + "</div>";
}
function feedErr(run, n) {
  return '<div class="gerr">' + ic("warn") + '<div class="grow"><p class="pt">The activity did not load</p><p>sous serve answered with an error when the view asked for the activity of ' + esc(n.label) +
    ". The step itself goes on. Try again, or follow it in a terminal.</p>" +
    '<div class="form-acts"><button class="btn sm" data-act="retry-load">Try again</button>' + cmdBox("sous show " + run.id) + "</div></div></div>";
}
function errHtml(msg, stack, what, open) {
  const lines = stack ? stack.split("\n").length : 0;
  return '<div class="errblk">' + (msg ? '<div class="em">' + esc(msg) + "</div>" : "") +
    (stack ? '<details class="fold"' + ((open == null ? !msg : open) ? " open" : "") + '><summary><span class="chev">' + I.chev + "</span>" + esc(what) + ", " + plural(lines, "line") + '</summary><div class="in"><pre class="out" tabindex="0">' + esc(stack) + "</pre></div></details>" : "") + "</div>";
}

/* activity: one line per event, with the time and the kind */
const TOOL_ICON = { Read: "file", Edit: "edit", Write: "edit", apply_patch: "edit", Bash: "term", shell: "term", Grep: "search", Glob: "search" };
function stampActs(run, n) {
  const acts = n.acts || [];
  const base = run.startedAt + (n.start || 0);
  const stop = n.askedAt != null ? n.askedAt : n.end != null ? n.end : runElapsed(run);
  const span = Math.max(1000, stop - (n.start || 0));
  acts.forEach((a, i) => { if (!a.at) a.at = base + Math.round(span * 0.97 * (acts.length > 1 ? i / (acts.length - 1) : 0)); });
}
/* ids such as BILL-212 or r-8d2v7f never break at their hyphen */
const keepIds = (h) => h.replace(/\b([A-Z][A-Z0-9]*-\d+|[rq]-[a-z0-9]{4,})\b/g, '<span class="nw">$1</span>');
function actLine(a) {
  const tm = '<span class="tm">' + timeEl(a.at, { quiet: true }) + "</span>";
  switch (a.k) {
    /* the call on one line, its whole result on the next, wrapped, as a terminal shows it */
    case "tool": return '<div class="act tool">' + tm + '<span class="kd">tool</span><span class="t"><span class="call"><b class="mono">' + esc(a.n) + "</b> <code>" + keepIds(esc(a.a)) + "</code></span>" + (a.r ? '<span class="res">' + keepIds(esc(a.r)) + "</span>" : "") + "</span></div>";
    case "text": return '<div class="act msg">' + tm + '<span class="kd">says</span><span class="t">' + keepIds(esc(a.t)) + "</span></div>";
    case "asks": return '<div class="act ask">' + tm + '<span class="kd">asks</span><span class="t">' + keepIds(esc(a.t)) + "</span></div>";
    case "tell": return '<div class="act tell">' + tm + '<span class="kd">tell</span><span class="t"><b>You:</b> ' + esc(a.t) + (a.dlv === "pending" ? '<span class="sub">The step reads the message after its current tool call.</span>' : "") + '</span><span class="r">' + (a.dlv === "pending" ? "not read yet" : "delivered") + "</span></div>";
    case "answer": return '<div class="act tell">' + tm + '<span class="kd">answer</span><span class="t"><b>You:</b> ' + esc(a.t) + "</span></div>";
    case "note": return '<div class="act">' + tm + '<span class="kd">note</span><span class="t">' + esc(a.t) + "</span></div>";
    case "error": return '<div class="act err">' + tm + '<span class="kd">error</span><span class="t">' + esc(a.t) + "</span></div>";
  }
  return "";
}
function actsHtml(run, n) {
  stampActs(run, n);
  const acts = (n.acts || []).filter((a) => a.k !== "prompt");
  if (!acts.length) {
    if (n.status === "running") return '<p class="noact">No activity yet. The step started ' + fmtDur(durOf(n)) + " ago" + (n.q ? ", after " + fmtDur(n.q) + " waiting for a slot" : "") + ". Lines show here as the agent works.</p>";
    return '<p class="noact">No activity.</p>';
  }
  const key = run.id + n.id, LIMIT = 50;
  const hidden = ui.showAll[key] ? 0 : Math.max(0, acts.length - LIMIT);
  const shown = acts.slice(hidden);
  /* runs of 5 or more tool calls fold into one line, except the last run of a live step */
  let html = hidden ? '<button class="more-btn" data-more="' + esc(key) + '">Show ' + plural(hidden, "earlier line") + "</button>" : "";
  let i = 0;
  while (i < shown.length) {
    let j = i;
    while (j < shown.length && shown[j].k === "tool") j++;
    const tail = j === shown.length && n.status === "running";
    if (j - i >= 5 && !tail) {
      const grp = shown.slice(i, j), counts = {};
      grp.forEach((a) => { counts[a.n] = (counts[a.n] || 0) + 1; });
      html += '<details class="fold"><summary><span class="chev">' + I.chev + "</span>" + plural(grp.length, "tool call") + ": " + esc(Object.keys(counts).map((k) => k + " " + counts[k]).join(", ")) + '</summary><div class="in">' + grp.map(actLine).join("") + "</div></details>";
      i = j;
    } else if (j > i) { html += shown.slice(i, j).map(actLine).join(""); i = j; }
    else { html += actLine(shown[i]); i++; }
  }
  if (n.status === "running") html += '<div class="act working">' + si("running", false) + '<span class="t">Working</span></div>';
  return html;
}

/* ------------------------------------------------------------------ graph: layout, then HTML nodes on an SVG of connectors */
const NW = 220, NH = 36, GY = 12, HDR = 28, PAD = 12, FAN = 12, RAD = 6;
let GX = 48;
function gLay(g) {
  if (g.t === "leaf" || g.folded) return Object.assign(g, { w: NW, h: NH, port: NH / 2 });
  /* an early end hangs under the step it checks, so it takes no column of its own */
  if (g.t === "exit") { gLay(g.main); gLay(g.exit); return Object.assign(g, { w: Math.max(g.main.w, g.exit.w), h: g.main.h + GY + g.exit.h, port: g.main.port }); }
  if (g.t === "seq") {
    g.items.forEach(gLay);
    const port = g.items.reduce((m, x) => Math.max(m, x.port), 0);
    let x = 0, h = 0;
    g.items.forEach((it, i) => { it.rx = x; it.ry = port - it.port; x += it.w + (i < g.items.length - 1 ? GX : 0); h = Math.max(h, it.ry + it.h); });
    return Object.assign(g, { w: x, h, port });
  }
  g.lanes.forEach(gLay);
  const multi = g.lanes.length > 1, lx = PAD + (multi ? FAN : 0);
  let y = HDR, w = 0;
  g.lanes.forEach((l, i) => { l.rx = lx; l.ry = y; y += l.h + (i < g.lanes.length - 1 ? GY : 0); w = Math.max(w, l.w); });
  return Object.assign(g, { w: Math.max(232, lx + w + (multi ? FAN : 0) + PAD), h: y + PAD, port: HDR + g.lanes[0].port, multi, lx });
}
function gEmit(g, x, y, out) {
  if (g.t === "leaf") { out.nodes.push(gLeaf(g, x, y)); return; }
  if (g.t === "exit") {
    const ey = y + g.main.h + GY;
    gEmit(g.main, x, y, out); gEmit(g.exit, x, ey, out);
    out.paths.push("M" + (x + NW / 2) + " " + (y + g.main.h) + "V" + ey);
    return;
  }
  if (g.t === "seq") {
    g.items.forEach((it, i) => {
      gEmit(it, x + it.rx, y + it.ry, out);
      if (i > 0) { const p = g.items[i - 1]; out.paths.push("M" + (x + p.rx + p.w) + " " + (y + g.port) + "H" + (x + it.rx)); }
    });
    return;
  }
  out.boxes.push(gBox(g, x, y));
  if (g.folded) return;
  const py = y + g.port, right = x + g.w;
  g.lanes.forEach((l) => {
    gEmit(l, x + l.rx, y + l.ry, out);
    const ly = y + l.ry + l.port, sx = x + l.rx + l.w;
    if (ly === py) { out.paths.push("M" + x + " " + py + "H" + (x + l.rx), "M" + sx + " " + py + "H" + right); return; }
    const fx = x + PAD, rx = right - PAD;
    out.paths.push("M" + x + " " + py + "H" + (fx - RAD) + "Q" + fx + " " + py + " " + fx + " " + (py + RAD) + "V" + (ly - RAD) + "Q" + fx + " " + ly + " " + (fx + RAD) + " " + ly + "H" + (x + l.rx));
    out.paths.push("M" + sx + " " + ly + "H" + (rx - RAD) + "Q" + rx + " " + ly + " " + rx + " " + (ly - RAD) + "V" + (py + RAD) + "Q" + rx + " " + py + " " + (rx + RAD) + " " + py + "H" + right);
  });
}
function gLeaf(g, x, y) {
  const cls = "gnode" + (g.status === "waiting" ? " needs" : "") + (g.status === "failed" || g.bad ? " bad" : "") + (g.status === "queued" || g.status === "skipped" ? " queued" : "") + (g.dec ? " dec" : "") + (g.sel ? " sel" : "");
  const icon = g.status ? si(g.status, false) : "";
  const pos = x == null ? "" : ' style="left:' + x + "px;top:" + y + 'px"';
  const aria = g.label + (g.status ? ", " + (ST_LABEL[g.status] || g.status) : "") + (g.d ? ", " + g.d : "") + (g.bad ? ", has a problem" : "");
  return '<button type="button" class="' + cls + '"' + pos + " " + g.attr + ' aria-label="' + esc(aria) + '"' + (g.label.length > 22 || g.tip ? ' data-tip="' + esc(g.tip || g.label) + '"' : "") + ">" +
    icon + (g.kind && KIND_ICON[g.kind] && !g.status ? ki(g.kind) : "") + '<span class="nm">' + esc(g.label) + "</span>" + (g.d ? '<span class="d">' + esc(g.d) + "</span>" : "") + "</button>";
}
/* A folded box is one node: its status icon, its name, what it holds, and a button that opens it.
   Its border turns copper or red when a step inside needs you or failed. */
/* The name stays whole. In a narrow box the header takes the short sub, and a tooltip gives the rest. */
function gHead(g, wide) {
  const st = g.status && (g.folded || g.wf);
  const full = g.folded ? g.fsub || "" : g.wfSub || g.sub || "";
  const room = wide ? 1e9 : g.w - 76 - g.title.length * 7.5;
  const sub = full.length * 6.5 <= room || !g.fsub ? full : g.fsub;
  const cut = wide ? (g.title + full).length > 34 : sub.length * 6.5 > room || sub !== full;
  const tip = cut ? ' data-tip="' + esc(g.title + ", " + full) + '"' : "";
  const aria = (g.folded ? "Show the steps of " : "Fold ") + g.title + (g.folded && g.status ? ", " + (ST_LABEL[g.status] || g.status) : "") + (g.folded && g.need ? ", a step inside needs you" : g.folded && g.bad ? ", a step inside failed" : "");
  return (st ? si(g.status, false) : ki(g.kind)) + '<span class="t"' + tip + ">" + esc(g.title) + '</span><span class="s"' + tip + ">" + esc(sub) + "</span>" +
    (g.foldKey ? '<button class="fold" data-gfold="' + esc(g.foldKey) + '" aria-expanded="' + !g.folded + '" aria-label="' + esc(aria) + '" data-tip="' + (g.folded ? "Show the steps inside" : "Fold to one node") + '">' + (g.folded ? I.plus : I.minus) + "</button>" : "");
}
const gFlags = (g) => (g.folded ? " folded" : "") + (g.folded && g.need ? " needs" : "") + (g.folded && g.bad && !g.need ? " bad" : "");
function gBox(g, x, y) {
  return '<div class="gbox' + (g.wf ? " wf" : "") + gFlags(g) + '" style="left:' + x + "px;top:" + y + "px;width:" + g.w + "px;height:" + g.h + 'px"><div class="gh"' + (g.folded ? ' style="height:' + (NH - 2) + 'px"' : "") + ">" + gHead(g) + "</div></div>";
}
function gVert(g) {
  if (g.t === "leaf") return gLeaf(g, null, null);
  if (g.t === "exit") return gVert(g.main) + gVert(g.exit);
  if (g.t === "seq") return '<div class="vseq">' + g.items.map(gVert).join("") + "</div>";
  return '<div class="vbox' + (g.wf ? " wf" : "") + (g.lanes.length > 1 && !g.folded ? " multi" : "") + gFlags(g) + '"><div class="gh">' + gHead(g, true) + "</div>" + (g.folded ? "" : '<div class="vlanes">' + g.lanes.map(gVert).join("") + "</div>") + "</div>";
}
/* A graph reads left to right in columns, with column gaps down to 24px. When the columns do not fit the box, it folds
   the boxes nested in other boxes, then wraps its columns into rows, as text wraps, then turns top to bottom.
   So every node shows at 100%. fitGraphs() picks the way after each draw and on resize. Zoom only goes up from 100%,
   so text never gets under 13px, and the box then scrolls with a bar and a faded edge. */
const GRAPHS = {}, GAPS = [48, 32, 24], GM = 16, RG = 32;
function graphHtml(g, key, label) {
  GRAPHS[key] = { g, label };
  if (ui.mode === "grapherr") return graphErr(key);
  return '<div class="gwrap" data-gkey="' + esc(key) + '" data-mode="h" data-gap="48" data-sig="">' + graphInner(key, "h", 48) + "</div>";
}
function gWidth(g, gap) { GX = gap; gLay(g); GX = 48; return g.w + 2 * GM; }
/* The top-level columns in rows of the box's width, left to right. Null when a column is wider than the box, or a row
   but the last is under half the box, since then the rows would read as a column. */
function gRows(g, gap, cw) {
  GX = gap; g.items.forEach(gLay); GX = 48;
  const avail = cw - 2 * GM, rows = [];
  if (g.items.some((it) => it.w > avail)) return null;
  let cur = null, w = 0;
  g.items.forEach((it) => { if (cur && w + gap + it.w <= avail) { cur.push(it); w += gap + it.w; } else { cur = [it]; rows.push(cur); w = it.w; } });
  const rw = (r) => r.reduce((a, it, i) => a + it.w + (i ? gap : 0), 0);
  if (rows.length < 2 || rows.slice(0, -1).some((r) => rw(r) < avail / 2)) return null;
  return { gap, rows };
}
/* from the end of one row, round the right side, back under the row, and into the start of the next */
function gReturn(xr, y1, y2, ym) {
  const xe = xr + 8, xl = GM - 8;
  return "M" + xr + " " + y1 + "H" + (xe - RAD) + "Q" + xe + " " + y1 + " " + xe + " " + (y1 + RAD) + "V" + (ym - RAD) + "Q" + xe + " " + ym + " " + (xe - RAD) + " " + ym +
    "H" + (xl + RAD) + "Q" + xl + " " + ym + " " + xl + " " + (ym + RAD) + "V" + (y2 - RAD) + "Q" + xl + " " + y2 + " " + (xl + RAD) + " " + y2 + "H" + GM;
}
function graphInner(key, mode, gap) {
  const G = GRAPHS[key], { g, label } = G;
  if (mode === "v") return '<div class="vg" role="group" aria-label="' + esc(label) + '">' + gVert(g) + "</div>";
  const out = { nodes: [], boxes: [], paths: [] };
  let W, H;
  GX = gap;
  if (mode === "w" && G.rows) {
    let y = GM, prev = null, py = 0;
    W = 0;
    G.rows.forEach((items) => {
      const row = gLay({ t: "seq", items });
      gEmit(row, GM, y, out);
      if (prev) out.paths.push(gReturn(GM + prev.w, py + prev.port, y + row.port, py + prev.h + RG / 2));
      W = Math.max(W, row.w); prev = row; py = y; y += row.h + RG;
    });
    W += 2 * GM; H = y - RG + GM;
  } else {
    gLay(g); gEmit(g, GM, GM, out);
    W = g.w + 2 * GM; H = g.h + 2 * GM;
  }
  GX = 48;
  const z = ui.zoom[key] || 1, off = z <= 1 ? ' aria-disabled="true"' : "";
  return '<div class="gscroll' + (z > 1 ? " zoomed" : "") + '" data-scroll-x tabindex="0" role="region" aria-label="' + esc(label) + '" data-w="' + W + '" data-h="' + H + '">' +
    '<div class="gsizer" style="width:' + Math.round(W * z) + "px;height:" + Math.round(H * z) + 'px"><div class="gcanvas" style="width:' + W + "px;height:" + H + "px;transform:scale(" + z + ')">' +
    out.boxes.join("") + '<svg class="gsvg" width="' + W + '" height="' + H + '" aria-hidden="true"><path d="' + out.paths.join("") + '"/></svg>' + out.nodes.join("") + "</div></div></div>" +
    '<div class="gzoom" role="group" aria-label="Zoom"><button type="button" data-zoom="out" aria-label="Zoom out" data-tip="Zoom out"' + off + ">" + I.minus + '</button><button type="button" data-zoom="in" aria-label="Zoom in" data-tip="Zoom in">' + I.plus + '</button><button type="button" data-zoom="fit" aria-label="Back to 100%, every node in the box" data-tip="Back to 100%"' + off + ">" + I.fit + "</button></div>";
}
/* the boxes that fold and that the person has not opened or folded by hand, with how deep each sits */
function autoBoxes(g, depth, out) {
  out = out || [];
  if (g.t === "box" && g.foldKey && g.auto) out.push({ b: g, depth });
  (g.t === "exit" ? [g.main, g.exit] : g.items || g.lanes || []).forEach((c) => autoBoxes(c, depth + (g.t === "box" ? 1 : 0), out));
  return out;
}
/* In this order, each with a gap of 48, 32 or 24px: one row of columns; one row with the boxes nested in other boxes
   folded; rows of columns; rows with the nested boxes folded. Then top to bottom. A fold chosen by hand stays. */
function fitGraphs() {
  $$(".gwrap[data-gkey]").forEach((w) => {
    const key = w.getAttribute("data-gkey"), G = GRAPHS[key];
    if (!G || !w.clientWidth) return;
    const autos = autoBoxes(G.g, 0), all = autos.map((a) => a.b), nested = autos.filter((a) => a.depth > 0).map((a) => a.b);
    const fold = (list) => all.forEach((b) => { b.folded = list.includes(b); });
    let mode = "v", gap = 0;
    G.rows = null;
    /* under 700px the graph always reads top to bottom, with 40px nodes for touch */
    if (window.innerWidth >= 700) {
      const tries = [["h", []], ["h", nested], ["w", []], ["w", nested]].filter(([, l], i) => i % 2 === 0 || l.length);
      for (const [m, list] of tries) {
        fold(list);
        if (m === "h") gap = GAPS.find((gp) => gWidth(G.g, gp) <= w.clientWidth) || 0;
        else {
          const R = GAPS.map((gp) => gRows(G.g, gp, w.clientWidth)).filter(Boolean).sort((a, b) => a.rows.length - b.rows.length)[0];
          if (R) { G.rows = R.rows; gap = R.gap; }
        }
        if (gap) { mode = m; break; }
      }
    }
    if (mode === "v") fold([]);
    const sig = mode + ":" + gap + ":" + all.map((b) => (b.folded ? 1 : 0)).join("") + ":" + (G.rows ? G.rows.map((r) => r.length).join(",") : "");
    if (w.getAttribute("data-sig") !== sig) {
      const a = w.contains(document.activeElement) ? document.activeElement : null;
      const attr = a && ["data-open-step", "data-wf-step", "data-gfold", "data-zoom"].find((k) => a.hasAttribute(k));
      w.innerHTML = graphInner(key, mode, gap || 48);
      w.setAttribute("data-sig", sig); w.setAttribute("data-mode", mode); w.setAttribute("data-gap", String(gap || 0));
      if (a) { const f = (attr && $("[" + attr + '="' + a.getAttribute(attr) + '"]', w)) || $(".gnode", w); if (f) f.focus(); }
    }
    w.classList.toggle("vert", mode === "v");
    gEdges(w);
  });
}
/* a faded edge on the side that has more, while the box scrolls */
function gEdges(w) {
  const sc = w && $(".gscroll", w);
  if (!sc) return;
  w.classList.toggle("cut-l", sc.scrollLeft > 1);
  w.classList.toggle("cut-r", sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1);
}
function graphErr(key) {
  const run = key.indexOf("run:") === 0 ? key.slice(4) : null, w = run ? null : WF[key.slice(3)];
  return '<div class="gerr">' + ic("warn") + '<div class="grow"><p class="pt">The graph did not load</p><p>sous serve answered with an error when the view asked for the steps of this ' + (run ? "run" : "workflow") +
    ". The rest of the page is current. Try again, or read it in a terminal.</p>" +
    '<div class="form-acts"><button class="btn sm" data-act="retry-load">Try again</button>' + cmdBox(run ? "sous show " + run : "sous check " + (w ? w.path : "")) + "</div></div></div>";
}
function runGraph(run, sel) {
  const gf = (n) => { const k = run.id + ":" + n.id; return k in ui.gfold ? ui.gfold[k] : false; };
  const leaf = (n, o) => Object.assign({ t: "leaf", id: n.id, label: n.label, kind: n.k, status: n.status, d: n.status === "queued" ? "" : fmtDur(durOf(n)), sel: sel === n.id, attr: 'data-open-step="' + n.id + '"' }, o || {});
  const seq = (kids) => ({ t: "seq", items: kids.map(conv) });
  /* each box folds to one node; it keeps the status, and whether a step inside needs you or failed */
  const units = (n) => !isGroup(n) || n.k === "gate" || n.k === "retry" || !n.kids.length ? [n] : n.kids.reduce((a, c) => a.concat(units(c)), n.k === "bp" ? [n] : []);
  const box = (n, o) => { const k = run.id + ":" + n.id, u = units(n); return Object.assign({ t: "box", status: n.status, need: u.some((x) => x.status === "waiting"), bad: u.some((x) => x.status === "failed"), foldKey: k, folded: gf(n), auto: !(k in ui.gfold) }, o); };
  function conv(n) {
    if (!isGroup(n)) return leaf(n);
    if (n.k === "gate" || n.k === "retry") return leaf(n, { d: n.kids.length + " of " + n.max, tip: n.label + ", " + nodeSub(n) });
    if (!n.kids.length) return leaf(n, { label: n.k === "pipe" ? "pipeline" : n.label, d: "" });
    if (n.k === "par") return box(n, { kind: "par", title: "parallel", sub: plural(n.kids.length, "branch", "branches"), fsub: plural(n.kids.length, "branch", "branches"), lanes: n.kids.map((c) => seq([c])) });
    if (n.k === "pipe") return box(n, { kind: "pipe", title: "pipeline", sub: plural(n.kids.length, "item") + ", each on its own branch", fsub: plural(n.kids.length, "item"), lanes: n.kids.map((c) => c.k === "lane" ? seq(c.kids) : seq([c])) });
    if (n.k === "wf") return box(n, { wf: true, kind: "wf", title: n.label, wfSub: "workflow " + n.wf, fsub: plural(leavesOf(n).length, "step"), lanes: [seq(n.kids)] });
    if (n.k === "bp") return { t: "seq", items: n.kids.map(conv).concat([leaf(n, { kind: "bp", d: n.status === "waiting" ? "waits" : "" })]) };
    return seq(n.kids);
  }
  const all = unitsOf(run);
  const count = (s) => all.filter((n) => n.status === s).length;
  const sum = [["Steps", all.length], ["Done", count("done")], ["Running", count("running")], ["Need you", count("waiting")], ["Failed", count("failed")], ["Tokens", fmtTok(tokOf(run.tree))]].filter(([k, v]) => v || k === "Steps" || k === "Done");
  return '<div class="gsum">' + sum.map(([k, v]) => "<span>" + k + " <b>" + v + "</b></span>").join("") + "</div>" + graphHtml(seq(run.tree.kids), "run:" + run.id, "Graph of the steps of " + run.id) +
    (ui.mode === "grapherr" ? "" : '<p class="hint gcap">Select a step to see its details in the Steps view.</p>');
}

/* ------------------------------------------------------------------ live: clocks, bars and new activity, without drawing the page again */
let liveTick = 0;
function tick() {
  liveTick++;
  $$("[data-live-dur]").forEach((el) => { el.textContent = fmtDur(Date.now() - Number(el.getAttribute("data-live-dur"))); });
  if (liveTick % 15 === 0) $$("time[data-ago]").forEach((el) => { el.textContent = fmtAgo(Number(el.getAttribute("data-ago"))); });
  const r = ui.route;
  const run = r && r.sec === "runs" && r.id && runById(r.id);
  if (run && OPEN_RUN(run)) {
    const steps = $("#steps");
    if (steps) {
      const end = Number(steps.getAttribute("data-axis-end")), el = actElapsed(run);
      if (el > end) refreshSteps(run);
      else {
        steps.style.setProperty("--now", (el / end).toFixed(4));
        $$("[data-bar]", steps).forEach((b) => { b.style.width = pct(Math.max(0, el - Number(b.getAttribute("data-bar"))) / end * 100); });
      }
    }
  }
  if (liveTick % 4 === 0) {
    RUNS.forEach((rn) => rn.flat.forEach((n) => {
      if (n.status !== "running" || !n.live || n.acts.length > 60) return;
      const pool = POOLS[n.live];
      n.poolI = n.poolI || 0;
      const a = poolAct(pool[n.poolI % pool.length]);
      n.poolI++;
      a.at = Date.now();
      n.acts.push(a);
      n.tok = (n.tok || 0) + 380 + (n.poolI * 137) % 700;
      const box = $("#acts-" + n.id);
      if (box && run === rn && ui.mode !== "feederr") box.innerHTML = actsHtml(rn, n);
      if (run === rn) { const t = $("[data-run-tok]"), c = $("[data-run-cost]"); if (t) t.textContent = fmtTok(tokOf(rn.tree)); if (c) c.textContent = fmtCost(costOf(rn.tree)); }
    }));
    /* a pending message is read once the current tool call ends */
    RUNS.forEach((rn) => rn.flat.forEach((n) => (n.acts || []).forEach((a) => {
      if (a.k === "tell" && a.dlv === "pending" && a.sentAt && Date.now() - a.sentAt > 6000) { a.dlv = "delivered"; const box = $("#acts-" + n.id); if (box) box.innerHTML = actsHtml(rn, n); }
    })));
  }
}
function refreshSteps(run) {
  const steps = $("#steps");
  if (!steps) return;
  const active = document.activeElement, id = active && active.id, val = active && active.value;
  steps.outerHTML = stepsView(run, ui.route.params.step || null);
  if (id) { const el = document.getElementById(id); if (el) { el.focus(); if (val != null) el.value = val; } }
}
