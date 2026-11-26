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
  const view = p.view === "steps" || (p.step && p.view !== "graph") ? "steps" : "graph";
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
  const stop = open || run.status === "paused" ? '<button class="btn" data-act="stop"' + downAttr() + ">" + I.stop + "Stop</button>" : "";
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
    '<div class="viewbar"><nav class="seg" aria-label="View">' + [["graph", "Graph"], ["steps", "Steps"]].map(([k, l]) =>
      '<a href="#/runs/' + enc(run.id) + (k === "steps" ? "?view=steps" : "") + '"' + (view === k ? ' aria-current="page"' : "") + ">" + l + "</a>").join("") + "</nav>" +
    '<span class="r">' + done + " of " + plural(all.length, "step") + " done</span></div>" +
    (view === "graph" ? runGraph(run, sel) : stepsView(run, sel)) + aboutRun(run) + "</div>";
}
function crumbs(items) {
  return '<nav class="crumbs" aria-label="Breadcrumb">' + sideBtn() +
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
/* The muted text after a step name in the Steps view: the agent when it differs from the step name, a loop's round,
   an attempt's verdict, a pipeline's item count. Nothing that the icon or the name already says. */
function stepSub(n) {
  switch (n.k) {
    case "agent": return n.agent && n.agent !== n.label ? n.agent : "";
    case "gate": case "retry": return n.kids.length ? "round " + n.kids.length + " of " + n.max : "up to " + n.max + " rounds";
    case "attempt": return n.verdict || "";
    case "pipe": return plural(n.kids.length, "item");
    case "wf": return n.wf !== n.label ? n.wf : "";
  }
  return "";
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
    si(n.status, ST_LABEL[n.status]) + '<span class="nm">' + esc(name) + '</span><span class="nm2">' + esc(stepSub(n)) + "</span>" +
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

/* ------------------------------------------------------------------ graph: layout, then HTML nodes over one SVG of edges
   A graph is a tree of parts. leaf: one node. seq: parts in order. par: branches that fork from one point and join into one.
   box: a loop (with a back arrow), a nested workflow, or an open pipeline. iff: steps that run only on a condition, drawn as a
   detour under the line. ret: an early return, a branch down to its own end mark. start and end: the two marks.
   gLay sets each part's size and the line its edges run on: port, the y of a left-to-right graph, or rail, the x of a top to
   bottom one. gEmit places the parts and draws the edges. Every edge ends in an arrowhead at the step it leads to. */
const NH = 36, GY = 12, HDR = 28, PAD = 12, RAD = 6, AH = 6, MK = 5, GM = 16, RG = 40;
let GX = 40, TB = false, TBW = 360, NHT = 36;
/* text widths measured in the page's own fonts: "n" a node name, "l" a 12px label, "t" a box title, "m" 12px mono */
const TWF = { n: "13px", l: "12px", t: "500 12px" };
function tw(s, f) {
  const c = tw.c || (tw.c = document.createElement("canvas").getContext("2d"));
  if (!tw.sans) { const b = getComputedStyle(document.body); tw.sans = b.fontFamily; tw.mono = b.getPropertyValue("--mono"); }
  c.font = f === "m" ? "12px " + tw.mono : TWF[f || "n"] + " " + tw.sans;
  return Math.ceil(c.measureText(String(s || "")).width);
}
const LW = (s) => tw(s, "l");
/* a node's width follows its text: icon, name, then the agent, the retries, the count and the duration */
function leafW(g) {
  let w = 46 + tw(g.label);
  [g.sub, g.rt, g.tag].forEach((s) => { if (s) w += 8 + LW(s); });
  [g.n, g.d].forEach((s) => { if (s) w += 8 + tw(s, "m"); });
  return Math.max(92, Math.min(280, w));
}
const nodeLike = (g) => g.t === "leaf" || (g.t === "box" && g.folded);

/* ---- left to right */
const gapH = (a, b) => b.t === "ret" ? 14 : a.t === "start" || b.t === "end" ? 20 : Math.max(GX, (b.lin || a.lout) ? LW(b.lin || a.lout) + 28 : 0);
function layH(g) {
  switch (g.t) {
    case "start": case "end": return Object.assign(g, { w: 2 * MK, h: 2 * MK, port: MK, head: g.t === "end" });
    case "leaf": { const s = g.stack ? 4 : 0; return Object.assign(g, { nw: leafW(g), w: leafW(g) + s, h: NH + s, port: NH / 2, head: true }); }
    case "seq": {
      g.items.forEach(layH);
      /* an early return's label may run under the node or end mark after it, which end 18px under the line. Before a box, it keeps its room. */
      g.items.forEach((it, i) => { const n = g.items[i + 1] || { t: "end" }; if (it.t === "ret") it.w = nodeLike(n) || n.t === "end" ? 32 : it.ow; });
      const port = g.items.reduce((m, it) => Math.max(m, it.port), 0);
      let x = 0, h = 0, ow = 0;
      g.items.forEach((it, i) => {
        if (i) x += gapH(g.items[i - 1], it);
        it.rx = x; it.ry = port - it.port; x += it.w;
        h = Math.max(h, it.ry + it.h); ow = Math.max(ow, it.rx + (it.ow || it.w));
      });
      return Object.assign(g, { w: x, ow: Math.max(x, ow), h, port, head: !!(g.items[0] && g.items[0].head) });
    }
    case "ret": {
      const w = Math.max(32, LW(g.edge) + 30);
      return Object.assign(g, { w, ow: Math.max(w, 18 + LW(g.edge), 16 + 2 * MK + LW(g.outcome)), h: 18 + 50 + 2 * MK, port: 18, head: false });
    }
    case "iff": {
      const b = layH(g.body), bx = g.onBack ? 18 : 30;
      b.rx = bx; b.ry = NH / 2 + GY + NH / 2 - b.port + (g.onBack ? 0 : 6);
      return Object.assign(g, { w: bx + b.w + 18, h: b.ry + b.h, port: NH / 2, head: false });
    }
    case "par": {
      g.lanes.forEach(layH);
      const lx = 26;
      let y = 0, lw = 0;
      g.lanes.forEach((l, i) => { l.rx = lx; l.ry = y; y += l.h + (i < g.lanes.length - 1 ? GY : 0); lw = Math.max(lw, l.w); });
      return Object.assign(g, { w: lx + lw + 22, lw, h: y, port: g.lanes[0].port, head: false });
    }
    case "box": {
      const s = g.stack ? 4 : 0;
      if (g.folded) { const nw = Math.max(leafW({ label: g.title, sub: g.fsub, n: g.n, d: g.d }), 150); return Object.assign(g, { nw, w: nw + s, h: NH + s, port: NH / 2, head: true }); }
      const b = layH(g.body);
      b.rx = PAD; b.ry = HDR;
      const tl = 24 + tw(g.title, "t") + (g.sub ? 8 + LW(g.sub) : 0) + (g.n ? 8 + tw(g.n, "m") : 0) + (g.foldKey ? 36 : 12);
      const w = Math.max(tl, b.w + 2 * PAD, g.again ? LW(g.again) + 48 : 0);
      return Object.assign(g, { nw: w, w: w + s, h: HDR + b.h + (g.again ? 44 : PAD) + s, port: HDR + b.port, head: false });
    }
  }
  return g;
}

/* ---- top to bottom: one rail on the left, nodes hang from it, branches and detours step to the right */
function railOf(g) {
  if (g.t === "seq") return g.items.reduce((m, it) => Math.max(m, railOf(it)), 0);
  if (g.t === "box" && !g.folded) return PAD + railOf(g.body);
  return 17;
}
const gapV = (a, b) => b.t === "ret" ? 10 : (b.lin || a.lout) ? 30 : a.t === "start" || b.t === "end" ? 16 : 22;
function layV(g, W) {
  switch (g.t) {
    case "start": case "end": return Object.assign(g, { w: 17 + MK, h: 2 * MK, rail: 17, head: g.t === "end" });
    case "leaf": { const s = g.stack ? 4 : 0, nw = Math.min(W, TBW) - s; return Object.assign(g, { nw, w: nw + s, h: NHT + s, rail: 17, head: true }); }
    case "seq": {
      const R = railOf(g);
      let y = 0, w = 0;
      g.items.forEach((it, i) => {
        const sh = R - railOf(it);
        layV(it, W - sh);
        if (i) y += gapV(g.items[i - 1], it);
        it.rx = sh; it.ry = y; y += it.h; w = Math.max(w, sh + it.w);
      });
      return Object.assign(g, { w, h: y, rail: R, head: !!(g.items[0] && g.items[0].head) });
    }
    case "ret": {
      const xm = 17 + 14 + LW(g.edge) + 8;
      return Object.assign(g, { xm, w: Math.min(W, xm + 2 * MK + 8 + LW(g.outcome)), h: 30, rail: 17, head: false });
    }
    case "iff": {
      const bx = 31, b = layV(g.body, W - bx);
      b.rx = bx; b.ry = g.onBack ? 10 : 24;
      return Object.assign(g, { w: bx + b.w, h: b.ry + b.h + 18, rail: 17, head: false });
    }
    case "par": {
      const lx = 33;
      let y = 4, lw = 0;
      g.lanes.forEach((l, i) => { layV(l, W - lx - 18); l.rx = lx; l.ry = y; y += l.h + (i < g.lanes.length - 1 ? GY : 0); lw = Math.max(lw, l.w); });
      return Object.assign(g, { lw, w: lx + lw + 18, h: y + 16, rail: 17, head: false });
    }
    case "box": {
      const s = g.stack ? 4 : 0;
      if (g.folded) { const nw = Math.min(W, TBW) - s; return Object.assign(g, { nw, w: nw + s, h: NHT + s, rail: 17, head: true }); }
      const back = g.again ? 26 : 0, b = layV(g.body, Math.min(W, TBW + 2 * PAD + back) - 2 * PAD - back - s);
      b.rx = PAD; b.ry = HDR;
      const nw = Math.max(b.w + 2 * PAD + back, g.again ? LW(g.again) + 2 * PAD + back : 0);
      return Object.assign(g, { nw, w: nw + s, h: HDR + b.h + (g.again ? 30 : PAD) + s, rail: PAD + b.rail, head: false });
    }
  }
  return g;
}

/* ---- drawing */
const P2 = (n) => Math.round(n * 10) / 10;
function arrow(o, x, y, dir) {
  const a = AH, b = 3.5;
  const pts = { r: [[x, y], [x - a, y - b], [x - a, y + b]], l: [[x, y], [x + a, y - b], [x + a, y + b]], d: [[x, y], [x - b, y - a], [x + b, y - a]], u: [[x, y], [x - b, y + a], [x + b, y + a]] }[dir];
  o.heads.push("M" + pts.map((p) => P2(p[0]) + " " + P2(p[1])).join("L") + "Z");
}
const lab = (o, x, y, text, align) => { if (text) o.labels.push({ x, y, text, align: align || "c" }); };
/* first and last node of a part, for a loop's back arrow */
function firstNode(g) {
  if (nodeLike(g) || g.t === "box") return g;
  if (g.t === "seq") { for (const it of g.items) { const f = firstNode(it); if (f) return f; } return null; }
  if (g.t === "iff") return firstNode(g.body);
  if (g.t === "par") return firstNode(g.lanes[0]);
  return null;
}
function lastNode(g) {
  if (nodeLike(g) || g.t === "box") return g;
  if (g.t === "seq") { for (let i = g.items.length - 1; i >= 0; i--) { const f = g.items[i].t === "iff" ? null : lastNode(g.items[i]); if (f) return f; } return null; }
  if (g.t === "par") return lastNode(g.lanes[g.lanes.length - 1]);
  return null;
}
function emitH(g, x, y, o) {
  g.ax = x; g.ay = y;
  const py = y + g.port;
  switch (g.t) {
    case "start": o.marks.push('<circle class="mk0" cx="' + (x + MK) + '" cy="' + py + '" r="4.5"/>'); return;
    case "end": o.marks.push('<circle class="mk1" cx="' + (x + MK) + '" cy="' + py + '" r="5"/>'); return;
    case "leaf": o.nodes.push(gLeaf(g, x, y)); if (g.stack) o.boxes.push(gPlate(g, x, y)); return;
    case "seq":
      g.items.forEach((it, i) => {
        emitH(it, x + it.rx, y + it.ry, o);
        if (!i) return;
        const a = g.items[i - 1], x1 = a.ax + (a.nw != null ? a.nw : a.w), x2 = it.ax;
        o.paths.push("M" + x1 + " " + py + "H" + (it.head ? x2 - 3 : x2));
        if (it.head) arrow(o, x2, py, "r");
        lab(o, (x1 + x2) / 2, py - 10, it.lin || a.lout);
      });
      return;
    case "ret": {
      const sx = x + 10, ye = py + 50;
      o.paths.push("M" + x + " " + py + "H" + (x + g.w), "M" + sx + " " + py + "V" + (ye - 3));
      arrow(o, sx, ye, "d");
      o.marks.push('<circle class="jd" cx="' + sx + '" cy="' + py + '" r="2.5"/>', '<circle class="mk1" cx="' + sx + '" cy="' + (ye + MK) + '" r="5"/>');
      lab(o, sx + 8, py + 30, g.edge, "l");
      lab(o, sx + MK + 7, ye + MK, g.outcome, "l");
      return;
    }
    case "iff": {
      const b = g.body;
      emitH(b, x + b.rx, y + b.ry, o);
      const by = y + b.ry + b.port, bx = x + b.rx, be = bx + b.w, xf = x + 8, xj = x + g.w - 8;
      o.paths.push("M" + x + " " + py + "H" + (x + g.w));
      if (!g.onBack) {
        o.paths.push("M" + xf + " " + py + "V" + (by - RAD) + "Q" + xf + " " + by + " " + (xf + RAD) + " " + by + "H" + (bx - 3));
        arrow(o, bx, by, "r");
        o.marks.push('<circle class="jd" cx="' + xf + '" cy="' + py + '" r="2.5"/>');
        lab(o, bx + 4, py + 13, g.label, "l");
      }
      o.paths.push("M" + be + " " + by + "H" + (xj - RAD) + "Q" + xj + " " + by + " " + xj + " " + (by - RAD) + "V" + py);
      o.marks.push('<circle class="jd" cx="' + xj + '" cy="' + py + '" r="2.5"/>');
      return;
    }
    case "par": {
      const xm = x + 8, xj = x + 26 + g.lw + 12, multi = g.lanes.length > 1;
      g.lanes.forEach((l, i) => {
        emitH(l, x + l.rx, y + l.ry, o);
        const ly = y + l.ry + l.port, lx = x + l.rx, le = lx + l.w;
        if (!i) o.paths.push("M" + x + " " + py + "H" + (l.head ? lx - 3 : lx), "M" + le + " " + py + "H" + (x + g.w));
        else o.paths.push("M" + xm + " " + py + "V" + (ly - RAD) + "Q" + xm + " " + ly + " " + (xm + RAD) + " " + ly + "H" + (l.head ? lx - 3 : lx),
          "M" + le + " " + ly + "H" + (xj - RAD) + "Q" + xj + " " + ly + " " + xj + " " + (ly - RAD) + "V" + py);
        if (l.head) arrow(o, lx, ly, "r");
      });
      if (multi) o.marks.push('<circle class="jd" cx="' + xm + '" cy="' + py + '" r="2.5"/>', '<circle class="jd" cx="' + xj + '" cy="' + py + '" r="2.5"/>');
      return;
    }
    case "box": {
      if (g.folded) { o.nodes.push(gLeaf(g, x, y)); if (g.stack) o.boxes.push(gPlate(g, x, y)); return; }
      if (g.stack) o.boxes.push(gPlate(g, x, y));
      o.boxes.push(gBox(g, x, y));
      const b = g.body;
      emitH(b, x + b.rx, y + b.ry, o);
      o.paths.push("M" + x + " " + py + "H" + (b.head ? x + PAD - 3 : x + PAD), "M" + (x + PAD + b.w) + " " + py + "H" + (x + g.nw));
      if (b.head) arrow(o, x + PAD, py, "r");
      if (g.again) backH(g, o);
      return;
    }
  }
}
/* a loop's back arrow: from under its last step, along the bottom of the box, up into its first step */
function backH(g, o) {
  const F = firstNode(g.body), L = lastNode(g.body);
  if (!F || !L) return;
  const bot = (n) => n.ay + (nodeLike(n) ? NH : n.h - (n.stack ? 4 : 0));
  const yb = g.ay + HDR + g.body.h + 16, fb = bot(F), lb = bot(L);
  let x1 = L.ax + L.nw / 2, x2 = F.ax + F.nw / 2;
  if (F === L) { x1 = L.ax + L.nw * 0.62; x2 = L.ax + L.nw * 0.38; }
  o.paths.push("M" + x1 + " " + lb + "V" + (yb - RAD) + "Q" + x1 + " " + yb + " " + (x1 - RAD) + " " + yb + "H" + (x2 + RAD) + "Q" + x2 + " " + yb + " " + x2 + " " + (yb - RAD) + "V" + (fb + 3));
  arrow(o, x2, fb, "u");
  lab(o, (x1 + x2) / 2, yb + 12, g.again);
}
function emitV(g, x, y, o) {
  g.ax = x; g.ay = y;
  const rx = x + g.rail;
  switch (g.t) {
    case "start": o.marks.push('<circle class="mk0" cx="' + rx + '" cy="' + (y + MK) + '" r="4.5"/>'); return;
    case "end": o.marks.push('<circle class="mk1" cx="' + rx + '" cy="' + (y + MK) + '" r="5"/>'); return;
    case "leaf": o.nodes.push(gLeaf(g, x, y)); if (g.stack) o.boxes.push(gPlate(g, x, y)); return;
    case "seq":
      g.items.forEach((it, i) => {
        emitV(it, x + it.rx, y + it.ry, o);
        if (!i) return;
        const a = g.items[i - 1], y1 = a.ay + a.h - (a.stack ? 4 : 0), y2 = it.ay;
        o.paths.push("M" + rx + " " + y1 + "V" + (it.head ? y2 - 3 : y2));
        if (it.head) arrow(o, rx, y2, "d");
        lab(o, rx + 9, (y1 + y2) / 2, it.lin || a.lout, "l");
      });
      return;
    case "ret": {
      const sy = y + 18, xm = x + g.xm;
      o.paths.push("M" + rx + " " + y + "V" + (y + g.h), "M" + rx + " " + sy + "H" + (xm - 3));
      arrow(o, xm, sy, "r");
      o.marks.push('<circle class="jd" cx="' + rx + '" cy="' + sy + '" r="2.5"/>', '<circle class="mk1" cx="' + (xm + MK) + '" cy="' + sy + '" r="5"/>');
      lab(o, rx + 12, sy - 9, g.edge, "l");
      lab(o, xm + 2 * MK + 6, sy, g.outcome, "l");
      return;
    }
    case "iff": {
      const b = g.body;
      emitV(b, x + b.rx, y + b.ry, o);
      const bx = x + b.rx + b.rail, bt = y + b.ry, bb = bt + b.h, yj = bb + 12;
      o.paths.push("M" + rx + " " + y + "V" + (y + g.h));
      if (!g.onBack) {
        o.paths.push("M" + rx + " " + (y + 6) + "H" + (bx - RAD) + "Q" + bx + " " + (y + 6) + " " + bx + " " + (y + 6 + RAD) + "V" + (bt - 3));
        arrow(o, bx, bt, "d");
        lab(o, bx + 9, y + 15, g.label, "l");
      }
      o.paths.push("M" + bx + " " + bb + "V" + (yj - RAD) + "Q" + bx + " " + yj + " " + (bx - RAD) + " " + yj + "H" + rx);
      o.marks.push('<circle class="jd" cx="' + rx + '" cy="' + yj + '" r="2.5"/>');
      return;
    }
    case "par": {
      const xj = x + 33 + g.lw + 10, yb = y + g.h - 6;
      let lastIn = y;
      g.lanes.forEach((l) => {
        emitV(l, x + l.rx, y + l.ry, o);
        const f = firstNode(l), e = lastNode(l), fy = f ? f.ay + NHT / 2 : y + l.ry, ey = e ? e.ay + NHT / 2 : y + l.ry, fx = f ? f.ax : x + l.rx, ex = e ? e.ax + e.nw : x + l.rx;
        o.paths.push("M" + rx + " " + (fy - RAD) + "Q" + rx + " " + fy + " " + (rx + RAD) + " " + fy + "H" + (fx - 3));
        arrow(o, fx, fy, "r");
        o.paths.push("M" + ex + " " + ey + "H" + (xj - RAD) + "Q" + xj + " " + ey + " " + xj + " " + (ey + RAD) + "V" + yb);
        lastIn = Math.max(lastIn, fy - RAD);
      });
      o.paths.push("M" + rx + " " + y + "V" + lastIn, "M" + xj + " " + (yb - RAD) + "Q" + xj + " " + yb + " " + (xj - RAD) + " " + yb + "H" + (rx + RAD) + "Q" + rx + " " + yb + " " + rx + " " + (yb + RAD) + "V" + (y + g.h));
      if (g.lanes.length > 1) o.marks.push('<circle class="jd" cx="' + rx + '" cy="' + y + '" r="2.5"/>');
      return;
    }
    case "box": {
      if (g.folded) { o.nodes.push(gLeaf(g, x, y)); if (g.stack) o.boxes.push(gPlate(g, x, y)); return; }
      if (g.stack) o.boxes.push(gPlate(g, x, y));
      o.boxes.push(gBox(g, x, y));
      const b = g.body;
      emitV(b, x + b.rx, y + b.ry, o);
      const bt = y + b.ry, bb = bt + b.h;
      o.paths.push("M" + rx + " " + y + "V" + (b.head ? bt - 3 : bt), "M" + rx + " " + bb + "V" + (y + g.h - (g.stack ? 4 : 0)));
      if (b.head) arrow(o, rx, bt, "d");
      if (g.again) backV(g, o);
      return;
    }
  }
}
/* top to bottom, the back arrow runs up the right side of the box, from its last step into its first */
function backV(g, o) {
  const F = firstNode(g.body), L = lastNode(g.body);
  if (!F || !L) return;
  const xr = g.ax + g.nw - PAD - 6, fy = F.ay + NHT / 2, ly = L.ay + NHT / 2, fx = F.ax + F.nw, lx = L.ax + L.nw;
  if (F === L) {
    const yb = L.ay + NHT + 10;
    o.paths.push("M" + lx + " " + ly + "H" + (xr - RAD) + "Q" + xr + " " + ly + " " + xr + " " + (ly + RAD) + "V" + (yb - RAD) + "Q" + xr + " " + yb + " " + (xr - RAD) + " " + yb + "H" + (L.ax + L.nw * 0.5 + RAD) + "Q" + (L.ax + L.nw * 0.5) + " " + yb + " " + (L.ax + L.nw * 0.5) + " " + (yb - RAD) + "V" + (L.ay + NHT + 3));
    arrow(o, L.ax + L.nw * 0.5, L.ay + NHT, "u");
  } else {
    o.paths.push("M" + lx + " " + ly + "H" + (xr - RAD) + "Q" + xr + " " + ly + " " + xr + " " + (ly - RAD) + "V" + (fy + RAD) + "Q" + xr + " " + fy + " " + (xr - RAD) + " " + fy + "H" + (fx + 3));
    arrow(o, fx, fy, "l");
  }
  lab(o, xr + 4, g.ay + HDR + g.body.h + 14, g.again, "r");
}

/* ---- the HTML: nodes and boxes over the SVG */
function gLeaf(g, x, y) {
  const box = g.t === "box", st = g.status, name = box ? g.title : g.label, sub = box ? g.fsub : g.sub;
  const needs = st === "waiting" || g.need;
  const cls = "gnode" + (needs ? " needs" : "") + (g.bad && !needs ? " bad" : "") + (st === "queued" || st === "skipped" ? " queued" : "") + (g.stack ? " stack" : "") + (g.sel ? " sel" : "");
  const icon = st ? si(st, false) : ki(g.kind);
  const act = box && g.foldKey ? 'data-gfold="' + esc(g.foldKey) + '" aria-expanded="false"' : g.attr || "";
  const aria = (box && g.foldKey ? "Open " : "") + name + (g.n ? ", " + g.n.slice(1) + " items" : "") + (sub ? ", " + sub : "") + (st ? ", " + (ST_LABEL[st] || st) : "") + (g.d ? ", " + g.d : "") +
    (g.rt ? ", retries " + g.rt.slice(2) : "") + (g.tag ? ", " + g.tag : "") + (g.bad ? ", has a problem" : "") + (g.need && st !== "waiting" ? ", a step inside needs you" : "");
  const room = g.nw - 46 - [sub, g.rt, g.tag].reduce((a, s) => a + (s ? 8 + LW(s) : 0), 0) - [g.n, g.d].reduce((a, s) => a + (s ? 8 + tw(s, "m") : 0), 0);
  const tip = g.tip || tw(name) > room ? ' data-tip="' + esc(g.tip || name) + '"' : "";
  const tag = act ? "button" : "div";
  return "<" + tag + (act ? ' type="button"' : "") + ' class="' + cls + '" style="left:' + x + "px;top:" + y + "px;width:" + g.nw + "px;height:" + (TB ? NHT : NH) + 'px" ' + act + ' aria-label="' + esc(aria) + '"' + tip + ">" +
    icon + '<span class="nm">' + esc(name) + "</span>" + (sub ? '<span class="sub">' + esc(sub) + "</span>" : "") + (g.tag ? '<span class="tag">' + esc(g.tag) + "</span>" : "") +
    (g.rt ? '<span class="rt">' + esc(g.rt) + "</span>" : "") + (g.n ? '<span class="n">' + esc(g.n) + "</span>" : "") + (g.d ? '<span class="d">' + esc(g.d) + "</span>" : "") + "</" + tag + ">";
}
/* a pipeline is drawn as two offset borders: this is the one behind */
function gPlate(g, x, y) {
  const h = g.t === "box" && !g.folded ? g.h - 4 : TB ? NHT : NH;
  return '<div class="gplate' + (g.t === "box" && !g.folded ? " open" : "") + '" style="left:' + (x + 4) + "px;top:" + (y + 4) + "px;width:" + g.nw + "px;height:" + h + 'px"></div>';
}
function gBox(g, x, y) {
  const icon = g.kind === "loop" ? "" : g.status ? si(g.status, false) : ki(g.kind === "stack" ? "pipe" : "wf");
  return '<div class="gbox ' + g.kind + (g.need ? " needs" : "") + '" style="left:' + x + "px;top:" + y + "px;width:" + g.nw + "px;height:" + (g.h - (g.stack ? 4 : 0)) + 'px"><div class="gh"' +
    (TB ? ' style="padding-left:' + (g.rail + 10) + 'px"' : "") + ">" + icon + '<span class="t">' + esc(g.title) + "</span>" + (g.n ? '<span class="n">' + esc(g.n) + "</span>" : "") + (g.sub ? '<span class="s">' + esc(g.sub) + "</span>" : "") +
    (g.foldKey ? '<button type="button" class="fold" data-gfold="' + esc(g.foldKey) + '" aria-expanded="true" aria-label="Fold ' + esc(g.title) + '" data-tip="Fold to one node">' + I.minus + "</button>" : "") + "</div></div>";
}

/* A graph reads left to right, with column gaps down to 24px. When the columns do not fit the box, it folds the boxes
   nested in other boxes, then wraps its columns into rows, as text wraps, then turns top to bottom. So every node shows
   at 100%. fitGraphs() picks the way after each draw and on resize. Zoom only goes up from 100%, so text never gets
   under 13px, and the box then scrolls with a bar and a faded edge. */
const GRAPHS = {}, GAPS = [40, 32, 24];
function graphHtml(g, key, label) {
  GRAPHS[key] = { g, label, top: { t: "seq", items: [{ t: "start" }].concat(g.items, [{ t: "end" }]) } };
  if (ui.mode === "grapherr") return graphErr(key);
  return '<div class="gwrap" data-gkey="' + esc(key) + '" data-mode="h" data-gap="40" data-sig="">' + graphInner(key, "h", 40) + "</div>";
}
function gWidth(G, gap) { GX = gap; TB = false; layH(G.top); GX = 40; return G.top.ow + 2 * GM; }
/* The top-level columns in rows of the box's width. The start mark and an early return keep to the step after them,
   and an early return and the end mark to the step before. Null when a column is wider than the box, or a row but the last is under half the box. */
function gRows(G, gap, cw) {
  GX = gap; TB = false;
  const items = G.top.items, avail = cw - 2 * GM - 16, units = [];
  items.forEach(layH);
  items.forEach((it, i) => { if (units.length && (it.t === "ret" || it.t === "end" || ["start", "ret"].includes(items[i - 1].t))) units[units.length - 1].push(it); else units.push([it]); });
  const uw = (u) => u.reduce((a, it, i) => a + (i ? gapH(u[i - 1], it) : 0) + (i === u.length - 1 ? it.ow || it.w : it.w), 0);
  let rows = [], cur = null, w = 0, ok = true;
  units.forEach((u) => {
    const v = uw(u);
    if (v > avail) ok = false;
    const gp = cur ? gapH(cur[cur.length - 1], u[0]) : 0;
    if (cur && w + gp + v <= avail) { cur.push(...u); w += gp + v; } else { cur = u.slice(); rows.push(cur); w = v; }
  });
  const rowW = rows.map((r) => r.reduce((a, it, i) => a + (i ? gapH(r[i - 1], it) : 0) + it.w, 0));
  GX = 40;
  if (!ok || rows.length < 2 || rowW.slice(0, -1).some((x) => x < avail / 2)) return null;
  return { gap, rows };
}
/* from the end of one row, round the right side, back under the row, and into the start of the next */
function gReturn(o, xr, y1, y2, ym, head) {
  const xe = xr + 10, xl = GM - 8;
  o.paths.push("M" + xr + " " + y1 + "H" + (xe - RAD) + "Q" + xe + " " + y1 + " " + xe + " " + (y1 + RAD) + "V" + (ym - RAD) + "Q" + xe + " " + ym + " " + (xe - RAD) + " " + ym +
    "H" + (xl + RAD) + "Q" + xl + " " + ym + " " + xl + " " + (ym + RAD) + "V" + (y2 - RAD) + "Q" + xl + " " + y2 + " " + (xl + RAD) + " " + y2 + "H" + (head ? GM - 3 : GM));
  if (head) arrow(o, GM, y2, "r");
}
function graphInner(key, mode, gap) {
  const G = GRAPHS[key], { top, label } = G;
  const o = { nodes: [], boxes: [], paths: [], heads: [], marks: [], labels: [] };
  let W, H;
  GX = gap; TB = mode === "v"; NHT = window.innerWidth < 700 ? 40 : 36;
  if (TB) {
    TBW = G.tbw || 360;
    layV(top, TBW); emitV(top, GM, GM, o);
    W = top.w + 2 * GM; H = top.h + 2 * GM;
  } else if (mode === "w" && G.rows) {
    let y = GM, prev = null, py = 0;
    W = 0;
    G.rows.forEach((items) => {
      const row = layH({ t: "seq", items });
      emitH(row, GM, y, o);
      if (prev) gReturn(o, GM + prev.w, py + prev.port, y + row.port, py + prev.h + RG / 2, row.head);
      W = Math.max(W, row.ow); prev = row; py = y; y += row.h + RG;
    });
    W += 2 * GM + 12; H = y - RG + GM;
  } else {
    layH(top); emitH(top, GM, GM, o);
    W = top.ow + 2 * GM; H = top.h + 2 * GM;
  }
  const vert = TB;
  TB = false; GX = 40;
  const z = ui.zoom[key] || 1, off = z <= 1 ? ' aria-disabled="true"' : "";
  return '<div class="gscroll' + (z > 1 ? " zoomed" : "") + '" data-scroll-x tabindex="0" role="region" aria-label="' + esc(label) + '" data-w="' + W + '" data-h="' + H + '">' +
    '<div class="gsizer" style="width:' + Math.round(W * z) + "px;height:" + Math.round(H * z) + 'px"><div class="gcanvas' + (vert ? " tb" : "") + '" role="group" aria-label="' + esc(label) + '" style="width:' + W + "px;height:" + H + "px;transform:scale(" + z + ')">' +
    o.boxes.join("") + '<svg class="gsvg" width="' + W + '" height="' + H + '" aria-hidden="true"><path class="ge" d="' + o.paths.join("") + '"/><path class="gah" d="' + o.heads.join("") + '"/>' + o.marks.join("") + "</svg>" +
    o.labels.map((l) => '<span class="glab ' + l.align + '" style="left:' + P2(l.x) + "px;top:" + P2(l.y) + 'px" aria-hidden="true">' + esc(l.text) + "</span>").join("") + o.nodes.join("") + "</div></div></div>" +
    '<div class="gzoom" role="group" aria-label="Zoom"><button type="button" data-zoom="out" aria-label="Zoom out" data-tip="Zoom out"' + off + ">" + I.minus + '</button><button type="button" data-zoom="in" aria-label="Zoom in" data-tip="Zoom in">' + I.plus + '</button><button type="button" data-zoom="fit" aria-label="Back to 100%, every node in the box" data-tip="Back to 100%"' + off + ">" + I.fit + "</button></div>";
}
/* the boxes that fold and that the person has not opened or folded by hand, with how deep each sits */
function autoBoxes(g, depth, out) {
  out = out || [];
  if (g.t === "box" && g.foldKey && g.auto) out.push({ b: g, depth });
  const kids = g.t === "seq" ? g.items : g.t === "par" ? g.lanes : g.body ? [g.body] : [];
  kids.forEach((c) => autoBoxes(c, depth + (g.t === "box" ? 1 : 0), out));
  return out;
}
/* In this order, each with a gap of 40, 32 or 24px: one row of columns; one row with the boxes nested in other boxes
   folded; rows of columns; rows with the nested boxes folded. Then top to bottom, with the nested boxes folded.
   A fold chosen by hand stays. Under 700px the graph always reads top to bottom, with 40px nodes for touch. */
function fitGraphs() {
  $$(".gwrap[data-gkey]").forEach((w) => {
    const key = w.getAttribute("data-gkey"), G = GRAPHS[key];
    if (!G || !w.clientWidth) return;
    const cw = w.clientWidth, autos = autoBoxes(G.g, 0), all = autos.map((a) => a.b), nested = autos.filter((a) => a.depth > 0).map((a) => a.b);
    const fold = (list) => all.forEach((b) => { b.folded = list.includes(b); });
    let mode = "v", gap = 0;
    G.rows = null;
    if (window.innerWidth >= 700) {
      const tries = [["h", []], ["h", nested], ["w", []], ["w", nested]].filter(([, l], i) => i % 2 === 0 || l.length);
      for (const [m, list] of tries) {
        fold(list);
        if (m === "h") gap = GAPS.find((gp) => gWidth(G, gp) <= cw) || 0;
        else {
          const R = GAPS.map((gp) => gRows(G, gp, cw)).filter(Boolean).sort((a, b) => a.rows.length - b.rows.length)[0];
          if (R) { G.rows = R.rows; gap = R.gap; }
        }
        if (gap) { mode = m; break; }
      }
    }
    if (mode === "v") fold(nested);
    G.tbw = Math.min(420, cw - 2 * GM - 2);
    const sig = mode + ":" + gap + ":" + (mode === "v" ? G.tbw + ":" + window.innerWidth : "") + all.map((b) => (b.folded ? 1 : 0)).join("") + ":" + (G.rows ? G.rows.map((r) => r.length).join(",") : "");
    if (w.getAttribute("data-sig") !== sig) {
      const a = w.contains(document.activeElement) ? document.activeElement : null;
      const attr = a && ["data-open-step", "data-wf-step", "data-gfold", "data-zoom"].find((k) => a.hasAttribute(k));
      w.innerHTML = graphInner(key, mode, gap || 40);
      w.setAttribute("data-sig", sig); w.setAttribute("data-mode", mode); w.setAttribute("data-gap", String(gap || 0));
      if (a) { const f = (attr && $("[" + attr + '="' + a.getAttribute(attr) + '"]', w)) || $(".gnode", w); if (f) f.focus(); }
    }
    w.classList.toggle("vert", mode === "v");
    gEdges(w);
  });
}
/* the widths change once the web fonts load */
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { $$(".gwrap[data-gkey]").forEach((w) => w.setAttribute("data-sig", "")); fitGraphs(); });
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

/* ---- what the graph shows: a workflow's steps, the same for a saved workflow and a run. In a run, each saved step takes
   the status of the run's step with its name at the same level, a loop shows its latest round, and a pipeline its items. */
function sameLabel(saved, label) {
  if (saved === label) return true;
  if (!/\{\w+\}/.test(saved)) return false;
  return new RegExp("^" + saved.split(/\{\w+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+") + "$").test(label);
}
function take(C, scope, ok) { const m = (scope || []).find((n) => !C.used.has(n) && ok(n)); if (m) C.used.add(m); return m || null; }
const laneKids = (n) => (n.kids || []).reduce((a, c) => a.concat(c.k === "lane" ? c.kids : [c]), []);
const retriesOf = (x) => { const o = (x.opts || []).find((s) => /^retries: \d+/.test(s)); return o ? Number(o.slice(9)) : 0; };
const ranFor = (m) => !!m && m.start != null && m.status !== "queued" && m.status !== "skipped";
const runAttr = (C, m) => m ? 'data-open-step="' + m.id + '"' : "";
function wfParts(xs, C, scope, anc) {
  const items = [];
  xs.forEach((x) => [].concat(wfPart(x, C, scope, anc)).forEach((p) => { if (p) items.push(p); }));
  return { t: "seq", items };
}
function wfStep(x, C, m, anc) {
  const label = savedLabel(x), r = retriesOf(x);
  const g = { t: "leaf", label, kind: x.kind === "workflow" ? "wf" : x.kind, sub: x.kind === "agent" && x.agent !== label ? x.agent : x.kind === "workflow" && x.wf !== label ? x.wf : "" };
  if (!C.run) return Object.assign(g, { bad: !!x.bad, tag: (C.marks && C.marks[x.id]) || "", rt: r ? "↻ " + r : "", sel: C.sel === x.id, attr: 'data-wf-step="' + x.id + '"' });
  return Object.assign(g, {
    sub: "", tip: g.sub ? label + ", agent " + g.sub : "",
    status: m ? m.status : C.miss, d: ranFor(m) ? fmtDur(durOf(m)) : "", sel: !!m && C.sel === m.id, attr: runAttr(C, m || anc),
    rt: m && m.tries && m.tries.length > 1 ? "↻ " + (m.tries.length - 1) + " of " + (m.retries || r) : "",
  });
}
function wfPart(x, C, scope, anc) {
  const run = C.run;
  switch (x.t) {
    case "step": {
      if (run && x.kind === "workflow") { const m = take(C, scope, (n) => n.k === "wf" && sameLabel(x.label, n.label)); if (m) return wfBox(m, C); }
      return wfStep(x, C, run ? take(C, scope, (n) => !isGroup(n) && sameLabel(x.label, n.label)) : null, anc);
    }
    case "gate": case "retry": {
      const m = run ? take(C, scope, (n) => n.k === x.t && n.label === x.label) : null, last = m && m.kids.length ? m.kids[m.kids.length - 1] : null;
      /* a loop named after its first step takes the name of the call, so no name shows twice */
      const f = x.body[0], same = f && f.t === "step" && savedLabel(f) === x.label;
      return { t: "box", kind: "loop", title: same ? x.t : x.label, sub: last ? "round " + m.kids.length + " of " + m.max : "", again: (x.again || "again") + " ×" + x.max, body: wfParts(x.body, C, last ? last.kids : [], m || anc) };
    }
    case "if": return { t: "iff", label: x.edge || "if " + x.cond, onBack: !!x.onBack, body: wfParts(x.body, C, scope, anc) };
    case "dec": return { t: "ret", edge: x.edge || x.cond, lout: x.ok || "", outcome: x.outcome || x.end };
    case "par": {
      const m = run ? take(C, scope, (n) => n.k === "par") : null;
      return { t: "par", lanes: x.branches.map((b) => wfParts(b, C, m ? laneKids(m) : [], m || anc)) };
    }
    case "pipe": {
      const m = run ? take(C, scope, (n) => n.k === "pipe") : null, key = C.key + ":" + (m ? m.id : x.id), one = x.body.length === 1 ? x.body[0] : null;
      let body = null;
      if (m && m.kids.length) body = { t: "par", lanes: m.kids.map((it) => it.k === "wf" ? { t: "seq", items: [wfBox(it, C)] } : wfParts(x.body, C, it.k === "lane" ? it.kids : [it], it)) };
      else if (!run && !one) body = wfParts(x.body, C, null, null);
      const inside = m ? leavesOf(m) : [], need = inside.some((n) => n.status === "waiting");
      return { t: "box", kind: "stack", stack: true, title: x.over.replace(/^the /, ""),
        n: m && m.kids.length ? "×" + m.kids.length : "", status: run ? (m ? m.status : C.miss) : null, d: ranFor(m) ? fmtDur(durOf(m)) : "", need, bad: !need && inside.some((n) => n.status === "failed"),
        tip: "Pipeline over " + x.over + (one ? ", each runs " + (one.kind === "workflow" ? "the workflow " + one.wf : savedLabel(one)) : ""),
        body, foldKey: body ? key : "", folded: body ? (key in ui.gfold ? ui.gfold[key] : !need) : true, auto: false,
        attr: run ? runAttr(C, m || anc) : 'data-wf-step="' + x.id + '"', sel: run ? !!m && C.sel === m.id : C.sel === x.id };
    }
    case "bp": {
      const m = run ? take(C, scope, (n) => n.k === "bp" && n.label === x.title) : null;
      const g = { t: "leaf", label: x.title, kind: "bp" };
      if (!run) Object.assign(g, { sel: C.sel === x.id, attr: 'data-wf-step="' + x.id + '"' });
      else Object.assign(g, { status: m ? m.status : C.miss, sel: !!m && C.sel === m.id, attr: runAttr(C, m || anc) });
      return wfParts(x.body, C, m ? m.kids : [], m || anc).items.concat([g]);
    }
  }
  return null;
}
/* a nested workflow in a run: a box with its name, the first input as its note, and its own steps */
function wfBox(m, C) {
  const w = WF[m.wf], key = C.key + ":" + m.id, first = w && w.inputs[0] && m.inputs ? m.inputs[w.inputs[0].name] : "";
  const inside = leavesOf(m), need = inside.some((n) => n.status === "waiting"), note = typeof first === "string" ? first : "";
  const body = w ? wfParts(w.approvedGraph, C, m.kids, m) : runParts(m.kids, C);
  return { t: "box", kind: "wf", title: m.label, sub: note, fsub: note, status: m.status, d: ranFor(m) ? fmtDur(durOf(m)) : "", need, bad: !need && inside.some((n) => n.status === "failed"),
    tip: "Workflow " + m.wf + (note ? ", " + note : ""), body, foldKey: key, folded: key in ui.gfold ? ui.gfold[key] : false, auto: !(key in ui.gfold) };
}
/* a run whose workflow file is gone: its own steps, in the same parts */
function runParts(kids, C) {
  const items = [], leaf = (n, o) => Object.assign({ t: "leaf", label: n.label, kind: n.k, status: n.status, d: ranFor(n) ? fmtDur(durOf(n)) : "", sel: C.sel === n.id, attr: runAttr(C, n) }, o || {});
  kids.forEach((n) => {
    C.used.add(n);
    if (!isGroup(n)) items.push(leaf(n));
    else if (n.k === "gate" || n.k === "retry") {
      const last = n.kids[n.kids.length - 1], body = last ? runParts(last.kids, C) : null;
      items.push(body && body.items.length ? { t: "box", kind: "loop", title: n.label, sub: "round " + n.kids.length + " of " + n.max, again: "again ×" + n.max, body } : leaf(n, { kind: n.k }));
    } else if (n.k === "par") items.push({ t: "par", lanes: n.kids.map((c) => runParts(c.k === "lane" ? c.kids : [c], C)) });
    else if (n.k === "pipe") items.push(n.kids.length ? { t: "par", lanes: n.kids.map((c) => c.k === "wf" ? { t: "seq", items: [wfBox(c, C)] } : runParts(c.k === "lane" ? c.kids : [c], C)) } : leaf(n, { kind: "pipe" }));
    else if (n.k === "wf") items.push(wfBox(n, C));
    else if (n.k === "bp") { runParts(n.kids, C).items.forEach((p) => items.push(p)); items.push(leaf(n, { kind: "bp", d: "" })); }
    else runParts(n.kids, C).items.forEach((p) => items.push(p));
  });
  return { t: "seq", items };
}
function runGraph(run, sel) {
  const w = WF[run.wf], fresh = () => ({ run, sel, used: new Set(), key: run.id, miss: ["done", "failed", "stopped"].includes(run.status) ? "skipped" : "queued" });
  /* the steps that should show: every step but those of a loop's earlier rounds */
  const want = [], walk = (n) => { if (!isGroup(n)) want.push(n); else ((n.k === "gate" || n.k === "retry") ? n.kids.slice(-1) : n.kids).forEach(walk); };
  run.tree.kids.forEach(walk);
  let C = fresh(), g = w ? wfParts(w.approvedGraph, C, run.tree.kids, null) : null;
  if (!g || want.some((n) => !C.used.has(n))) { C = fresh(); g = runParts(run.tree.kids, C); }
  const all = unitsOf(run);
  const count = (s) => all.filter((n) => n.status === s).length;
  const sum = [["Steps", all.length], ["Done", count("done")], ["Running", count("running")], ["Need you", count("waiting")], ["Failed", count("failed")], ["Tokens", fmtTok(tokOf(run.tree))]].filter(([k, v]) => v || k === "Steps" || k === "Done");
  return '<div class="gsum">' + sum.map(([k, v]) => "<span>" + k + " <b>" + v + "</b></span>").join("") + "</div>" + graphHtml(g, "run:" + run.id, "Graph of the steps of " + run.id) +
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
