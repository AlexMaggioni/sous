/* sous view mock v3: workflow, start, agent, skill, MCP and settings pages, then menus, events and boot. */
"use strict";

const sec = (id, title, body, right) => '<section class="sec" aria-labelledby="' + id + '"><div class="sec-h"><h2 id="' + id + '">' + title + "</h2>" + (right ? '<span class="r">' + right + "</span>" : "") + "</div>" + body + "</section>";
const wfCalledBy = (name) => WORKFLOWS.filter((w) => !w.deleted && wfCalls(w).includes(name)).map((w) => w.name);
const projectOf = (w) => w.where === "home" ? ui.from : w.where;

/* ------------------------------------------------------------------ the layout of the workflow, agent, skill and MCP pages
   As a Linear issue: the header, a banner only for what needs the person or is wrong, then the content on the left and
   the details on the right. The details come first in the page, so under 1100px they sit under the header, and above
   that the tab order goes from the header's buttons at the top right down the details, then to the content. */
const fact = (label, value, o) => value == null || value === "" ? "" : "<div" + (o && o.wide ? ' class="wide"' : "") + "><dt>" + label + "</dt><dd>" + value + "</dd></div>";
const factSub = (html) => '<span class="sub">' + html + "</span>";
const noneVal = (t) => '<span class="muted">' + (t || "None") + "</span>";
const linkList = (xs) => '<span class="vlist">' + xs.join("") + "</span>";
/* a path shows its file name in mono, with the full path in a tooltip and a copy button */
const fileVal = (path, sub) => '<span class="fv"><code tabindex="0" data-tip="' + esc(path) + '">' + esc(String(path).split("/").pop()) + "</code>" +
  '<button class="copy" data-copy="' + esc(path) + '" aria-label="Copy the path" data-tip="Copy the path">' + I.copy + "</button></span>" + (sub ? factSub(sub) : "");
/* kind is needs (copper, the person must act), bad (red, something is wrong) or warn (gray, worth knowing before a run) */
const banner = (kind, icon, html, acts) => '<div class="banner ' + kind + '" role="note">' + ic(icon) + '<div class="grow"><p>' + html + "</p>" + (acts ? '<div class="bacts">' + acts + "</div>" : "") + "</div></div>";
function dpage(o) {
  return '<div class="page dpage">' + o.crumbs +
    '<div class="dhead"><div class="grow"><h1 class="title">' + esc(o.title) + "</h1>" + (o.desc ? '<p class="desc">' + esc(o.desc) + "</p>" : "") + "</div>" +
    (o.actions ? '<div class="actions">' + o.actions + "</div>" : "") + "</div>" + (o.banners ? '<div class="banners">' + o.banners + "</div>" : "") +
    (o.top ? '<div class="dtop">' + o.top + "</div>" : "") +
    '<div class="dgrid"><aside class="dside" aria-label="Details"><dl class="facts">' + o.facts.join("") + "</dl></aside>" +
    '<div class="dmain">' + o.content + "</div></div></div>";
}
const dsec = (id, title, body, right) => '<section class="dsec" aria-labelledby="' + id + '"><div class="dsec-h"><h2 id="' + id + '">' + title + "</h2>" + (right ? '<span class="r">' + right + "</span>" : "") + "</div>" + body + "</section>";

/* ------------------------------------------------------------------ saved workflow: graph, outline, inspector */
function diffMarks(w) {
  if (!w.approved.changedSince || w.approvedGraph === w.graph) return {};
  const old = {}, out = {};
  walkSaved(w.approvedGraph, (x) => { if (x.t === "step") old[x.label] = x; });
  walkSaved(w.graph, (x) => {
    if (x.t !== "step") return;
    const o = old[x.label];
    if (!o) out[x.id] = "new";
    else if (JSON.stringify([x.opts, x.model, x.cmd]) !== JSON.stringify([o.opts, o.model, o.cmd])) out[x.id] = "changed";
  });
  return out;
}
const SAVED_KIND = { gate: "gate", retry: "retry", if: "condition", dec: "early end", par: "parallel", pipe: "pipeline", bp: "breakpoint" };
const savedLabel = (x) => (x.label || x.title || (x.cond ? "if " + x.cond : SAVED_KIND[x.t])).replace(/\{(\w+)\}/g, "$1");
/* drawn by the same parts as a run's graph (wfParts in run.js), with kind icons in place of status icons */
function savedTree(w, sel) {
  return wfParts(w.graph, { sel, marks: diffMarks(w), key: "wf:" + w.name, used: new Set() }, null, null);
}
/* the Steps view of a saved workflow: one row per step, its kind icon, its name in mono, and at the right only what the name does not say */
function outlineHtml(w, sel) {
  const marks = diffMarks(w), rows = [];
  const walk = (xs, depth) => xs.forEach((x) => {
    const k = x.t === "step" ? x.kind : x.t, name = savedLabel(x);
    let d = x.t === "step" ? (x.kind === "agent" ? x.agent : x.kind === "workflow" ? x.wf : x.cmd || "") : x.t === "dec" ? x.end : (x.max ? "up to " + x.max : x.over ? "over " + x.over : "");
    if (d === name || name.includes(d)) d = "";
    const mark = x.bad ? '<span class="omk">' + si("failed", false) + "problem</span>" : marks[x.id] ? '<span class="omk"><span class="cdot" aria-hidden="true"></span>' + marks[x.id] + "</span>" : "";
    rows.push('<button class="oline' + (sel === x.id ? " sel" : "") + '" data-wf-step="' + x.id + '" aria-pressed="' + (sel === x.id) + '">' + '<span class="gd" aria-hidden="true"></span>'.repeat(depth) +
      ki(k === "workflow" ? "wf" : k) + '<span class="nm">' + esc(name) + "</span>" + mark + '<span class="d">' + esc(d) + "</span></button>");
    if (x.body) walk(x.body, depth + 1);
    if (x.branches) x.branches.forEach((b) => walk(b, depth + 1));
  });
  walk(w.graph, 0);
  return '<div class="outline">' + rows.join("") + "</div>";
}
function findLines(text, needle) {
  const L = text.split("\n");
  const i = L.findIndex((x) => x.includes(needle));
  if (i < 0) return null;
  let s = i;
  while (s > 0 && !/^\s*(const |await |if |return |\(.*?\) =>|\w+\()/.test(L[s])) s--;
  let depth = 0, e = s;
  for (; e < L.length && e < s + 30; e++) {
    const t = L[e].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
    for (const ch of t) { if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--; }
    if (depth <= 0 && e >= i) break;
  }
  return { start: s + 1, text: L.slice(s, e + 1).join("\n") };
}
function findSaved(w, id) { let f = null; walkSaved(w.graph, (x) => { if (x.id === id) f = x; }); return f; }
const OPT_TEXT = {
  keepSession: "It keeps its session, so a later step can go on in it.",
  ask: "It may stop with a line that starts with QUESTION:. People answer, and the same session goes on. A sixth question fails the step.",
  schema: "It returns an object that matches a schema, not text.",
  allowFail: "A non-zero exit does not fail the step. The workflow reads the exit code.",
};
function stepText(s) {
  const opts = (s.opts || []).map((o) => o.startsWith("continue") ? "It goes on in the session of the step " + o.split('"')[1] + "." : OPT_TEXT[o] || "").filter(Boolean);
  switch (s.t) {
    case "step":
      switch (s.kind) {
        case "agent": return ["Runs the agent " + s.agent + " with a prompt the file builds."].concat(opts);
        case "ask": return ["Waits for people to pick one of " + s.q.choices.length + " choices. Agents cannot answer it unless the file sets answeredBy: \"anyone\"."];
        case "checkpoint": return ["Asks people a yes or no question, then goes on."];
        case "choose": return ["An agent picks the next workflow from " + s.options.join(", ") + ", and sous runs it. It offers only workflows you approved."];
        case "workflow": return ["Runs the workflow " + s.wf + " inside this one, on a branch of its own. Workflows nest 5 levels deep at most."];
        default: return ["A code step. It runs on this machine and counts no tokens. A non-zero exit fails it."].concat(opts);
      }
    case "gate": return ["Runs the steps inside, then checks the result. When the check fails, it runs them again with the feedback. It passes when " + s.passes + "."];
    case "retry": return ["Runs the steps inside again while they fail. It passes when " + s.passes + "."];
    case "if": return ["Runs the steps inside only when " + s.cond + " is set. That happens " + s.note + "."];
    case "dec": return ["Ends the workflow early when " + s.cond + ". The workflow then " + s.end + "."];
    case "par": return ["Runs the branches at once. A branch that throws an error of its own gives null, and the others go on."];
    case "pipe": return ["Sends each of " + s.over + " through the steps inside. All of them run at once, each on its own branch."];
    case "bp": return ["Runs the step inside, then waits for you. You approve it, send it back with a note, or stop the run. It reruns 5 times at most."];
  }
  return [];
}
function inspector(w, s) {
  if (!s) return "";
  const project = projectOf(w), rows = [];
  const add = (k, v) => { if (v) rows.push("<dt>" + k + "</dt><dd>" + v + "</dd>"); };
  if (s.kind === "agent") {
    const m = savedModel(s, project), d = effDef(s.agent, project), codex = m.harness === "Codex";
    add("Agent", '<a class="lnk" href="#/agents/' + enc(s.agent) + '">' + esc(s.agent) + "</a>");
    add("Runs on", esc(m.harness) + (w.where === "home" ? '<span class="sub">seen from ' + esc(project) + "</span>" : ""));
    add("Model", esc(m.model) + (m.effort ? ", effort " + esc(m.effort) : ""));
    const sk = agentField(d, codex ? "codex" : "claude", "skills");
    add("Skills", codex ? "every skill in ~/.codex/skills" : sk ? sk.v.map((x) => '<a class="lnk" href="#/skills/' + enc(x) + '">' + esc(x) + "</a>").join(", ") : '<span class="muted">None</span>');
    const mc = s.mcp || (agentField(d, codex ? "codex" : "claude", "mcpServers") || {}).v;
    add("MCP servers", mc && mc.length ? mc.map((x) => '<a class="lnk" href="#/mcp/' + enc(x) + '">' + esc(x) + "</a>").join(", ") : '<span class="muted">None</span>');
  }
  if (s.kind === "workflow") add("Workflow", '<a class="lnk" href="#/workflows/' + enc(s.wf) + '">' + esc(s.wf) + "</a>" + (s.args ? ", with <code>" + esc(JSON.stringify(s.args)) + "</code>" : ""));
  if (s.cmd) add("Command", "<code>" + esc(s.cmd) + "</code>");
  if (s.q) add("Choices", esc(s.q.choices.join(", ")));
  if (s.options) add("Options", esc(s.options.join(", ")));
  if (s.max) add("Attempts", "up to " + s.max + (s.maxArg ? ", set by --" + esc(s.maxArg) : ""));
  if ((s.t === "gate" || s.t === "retry") && s.body) add("Steps inside", s.body.map((b) => '<button class="lnk-btn" data-wf-step="' + b.id + '">' + esc(savedLabel(b)) + "</button>").join(", "));
  if (s.opts && s.opts.length) add("Set in the file", "<code>" + esc(s.opts.join(", ")) + "</code>");
  /* the step's lines open in the Source view, so the page keeps one box */
  const L = findLines(w.text, s.find || 'label: "' + s.label + '"');
  const n = L ? L.text.split("\n").length : 0;
  const src = L && wfViewNow() !== "source" ? '<p class="isrc"><a class="lnk" href="#/workflows/' + enc(w.name) + "?view=source&step=" + enc(s.id) + '">' + (n > 1 ? "Lines " + L.start + " to " + (L.start + n - 1) : "Line " + L.start) + " in the file</a></p>" : "";
  const k = s.t === "step" ? (s.kind === "workflow" ? "wf" : s.kind) : s.t;
  return '<section class="inspector" id="insp" aria-labelledby="insp-h"><div class="dsec-h">' + ki(k) + '<h2 id="insp-h">' + esc(savedLabel(s)) + "</h2>" +
    '<span class="r"><button class="ibtn" data-wf-step="' + s.id + '" aria-label="Close the step" data-tip="Close">' + I.x + "</button></span></div>" +
    (s.bad ? banner("bad", "warn", esc(s.bad)) : "") +
    stepText(s).map((t) => '<p class="body">' + esc(t) + "</p>").join("") + (rows.length ? '<dl class="kv">' + rows.join("") + "</dl>" : "") + src + "</section>";
}
const wfViewNow = () => (ui.route && ui.route.params && ui.route.params.view) || "graph";
/* ------------------------------------------------------------------ workflow page */
function wfEmptyPage() {
  return '<div class="page">' + crumbs([["Workflows"]]) + '<div class="empty"><h1 class="title">No saved workflows</h1><p>sous saves a workflow the first time you approve it. A workflow is one JS file in ~/.sous/workflows or in a project\'s .sous/workflows.</p>' +
    "<p>The guide writes a first one with you.</p>" + cmdBox("sous guide") + "</div></div>";
}
/* a schedule reads in words, with the cron under it */
function cronWords(c) {
  const m = String(c).match(/^(\d+) (\d+) \* \* (\*|1-5|\d)$/);
  if (!m) return null;
  const at = pad2(+m[2]) + ":" + pad2(+m[1]);
  const days = { "*": "Every day", "1-5": "Weekdays", "0": "Sundays", "1": "Mondays", "2": "Tuesdays", "3": "Wednesdays", "4": "Thursdays", "5": "Fridays", "6": "Saturdays" };
  return days[m[3]] + " at " + at;
}
function scheduleVal(s) {
  if (!s) return noneVal();
  const [cron, ...rest] = String(s).split(", ");
  const words = cronWords(cron);
  return (words ? esc(words) + factSub("<code>" + esc(cron) + "</code>" + (rest.length ? ", " + esc(rest.join(", ")) : "")) : "<code>" + esc(s) + "</code>");
}
/* a run of a home workflow names its project, since home workflows run in any of them */
const wfRunRow = (r, home) => '<a class="wrun" href="#/runs/' + enc(r.id) + '" data-tip="' + esc(r.label) + '">' + si(runIcon(r), ST_LABEL[runIcon(r)]) + '<span class="nm">' + esc(r.label) + "</span>" +
  (home ? '<span class="pj">' + esc(r.project) + "</span>" : "") + '<span class="age">' + timeEl(r.startedAt, { quiet: true }) + "</span></a>";
function wfPage(w, sub, p) {
  const a = w.approved, view = ["steps", "source", "diff"].includes(p.view) ? p.view : "graph";
  const sel = p.step && findSaved(w, p.step) ? p.step : null, s = sel && findSaved(w, sel);
  const base = "#/workflows/" + enc(w.name);
  let banners = "";
  (w.problems || []).forEach((pr) => {
    const node = findSavedByLabel(w, pr.node);
    banners += banner("bad", "warn", '<span class="bt">sous check finds a problem.</span> ' + esc(pr.text) + " Start stays off until the file passes.",
      (node ? '<button class="btn sm" data-wf-step="' + node.id + '">Show the step</button>' : "") + cmdBox("sous check " + w.path));
  });
  if (a.changedSince) {
    const who = a.editedBy.charAt(0).toUpperCase() + a.editedBy.slice(1);
    banners += banner("needs", "dot", '<span class="bt">Changed since you approved it.</span> ' + esc(who) + " edited it " + timeEl(a.editedAt) + ". sous runs the approved text until you approve the change" +
      (w.problems ? "." : ", and Start shows the change first.") + (view === "diff" ? "" : ' <a href="' + base + '?view=diff">See what changed</a>'));
  }
  const called = wfCalledBy(w.name);
  const facts = [
    fact("Lives in", w.where === "home" ? "home" : esc(w.where)),
    fact("Started by", w.startedBy === "people" ? "People only" + factSub(w.schedule ? "and its schedule" : "Agents get a refusal") : "People or agents"),
    fact("Works in", w.place === "worktree" ? "A worktree" : w.place === "folder" ? "The project folder" : "No folder"),
    fact("Schedule", scheduleVal(w.schedule)),
    fact("Timeout", w.timeout ? '<span class="num">' + esc(w.timeout) + "</span>" : noneVal()),
    fact("Approved", timeEl(a.at) + factSub(a.seeded ? "by sous, on its first run" : "by " + esc(a.by))),
    fact("File", fileVal(w.path)),
    fact("Used by", called.length ? linkList(called.map((x) => '<a class="lnk" href="#/workflows/' + enc(x) + '">' + esc(x) + "</a>")) : noneVal()),
  ].concat((w.notes || []).map((n) => fact("Note", '<span class="small">' + esc(n) + "</span>", { wide: true })));
  const views = [["graph", "Graph"], ["steps", "Steps"], ["source", "Source"]].concat(a.changedSince ? [["diff", "Changes"]] : []);
  const viewbar = '<div class="dview"><nav class="seg" aria-label="View">' + views.map(([k, l]) => '<a href="' + base + (k === "graph" ? "" : "?view=" + k) + '"' + (view === k ? ' aria-current="page"' : "") + ">" + l + "</a>").join("") + "</nav>" +
    (view === "graph" && ui.mode !== "grapherr" && !sel ? '<span class="r">Select a step to see what it does</span>' : "") + "</div>";
  let body;
  if (view === "graph") body = graphHtml(savedTree(w, sel), "wf:" + w.name, "Graph of the workflow " + w.name);
  else if (view === "steps") body = outlineHtml(w, sel);
  else if (view === "diff") body = diffBlock(w.approvedText, w.text, w.path);
  else { const L = s && findLines(w.text, s.find || 'label: "' + s.label + '"'); const hit = L ? Array.from({ length: L.text.split("\n").length }, (_, i) => L.start + i) : []; body = codeBlock(w.text, { path: w.path, copy: true, hit, label: w.name + ".js" }); }
  const ins = '<dl class="kv">' + w.inputs.map((x) => "<dt><code>" + esc(x.name) + "</code></dt><dd>" + esc(x.description) + '<span class="sub">' + esc(x.type) + (x.required ? ", required" : "") + (x.def != null ? ", default " + esc(JSON.stringify(x.def)) : "") + (x.isNew && a.changedSince ? ", new in the edited file" : "") + "</span></dd>").join("") + "</dl>" +
    (w.outputs ? '<p class="hint dret">Returns ' + w.outputs.map((o) => "<code>" + esc(o[0]) + "</code>, " + esc(o[1].toLowerCase())).join("; ") + ".</p>" : "");
  const runs = liveRuns().filter((r) => r.wf === w.name && !r.gen).sort((x, y) => y.startedAt - x.startedAt).slice(0, 6);
  const runRows = runs.length ? '<div class="wruns">' + runs.map((r) => wfRunRow(r, w.where === "home")).join("") + "</div>" : '<p class="hint">No runs yet. Start one here, or from a terminal.</p>' + cmdBox("sous run " + w.name + (w.inputs[0] && w.inputs[0].required ? " --" + w.inputs[0].name + " ..." : ""));
  const start = w.problems ? '<button class="btn" type="button" aria-disabled="true" data-tip="Start stays off until sous check passes">' + I.play + "Start</button>"
    : '<a class="btn primary" href="#/runs/new/' + enc(w.name) + '">' + I.play + "Start</a>";
  return dpage({
    crumbs: crumbs([["Workflows", "#/workflows"], [w.name]]), title: w.name, desc: w.description,
    actions: start + '<button class="ibtn" data-menu="wf" data-wf="' + esc(w.name) + '" aria-haspopup="true" aria-expanded="false" aria-label="More actions" data-tip="More">' + I.more + "</button>",
    banners, facts,
    top: '<div class="dview-wrap">' + viewbar + body + "</div>" + inspector(w, s),
    content: dsec("wf-in", "Inputs", ins) + dsec("wf-runs", "Last runs", runRows, runs.length ? '<span class="num">' + runs.length + "</span>" : ""),
  });
}
function findSavedByLabel(w, label) { let f = null; walkSaved(w.graph, (x) => { if (x.label === label) f = x; }); return f; }

/* ------------------------------------------------------------------ start page */
const startVals = (w) => { const v = {}; w.inputs.forEach((x) => { if (x.def != null) v[x.name] = x.def; }); return Object.assign(v, ui.startVals[w.name] || {}); };
const startProj = (w) => w.where !== "home" ? w.where : (ui.startVals[w.name] || {}).__project || ui.from;
function startCmd(w) {
  const v = startVals(w), defs = {};
  w.inputs.forEach((x) => { if (x.def != null) defs[x.name] = x.def; });
  const parts = w.inputs.filter((x) => v[x.name] != null && String(v[x.name]).trim() !== "" && String(v[x.name]) !== String(defs[x.name] != null ? defs[x.name] : "")).map((x) => " --" + x.name + " " + shq(v[x.name]));
  return "sous run " + w.name + parts.join("") + " --project " + PROJECT_PATH[startProj(w)];
}
function startState(w) {
  if (w.problems) return { ok: false, why: "sous check finds a problem in the file. Fix the file to start it." };
  const v = startVals(w), miss = w.inputs.filter((x) => x.required && !String(v[x.name] == null ? "" : v[x.name]).trim());
  if (miss.length) return { ok: false, miss, why: "Fill in " + miss.map((x) => x.name).join(" and ") + " to start." };
  if (w.approved.changedSince && !ui.startVals["__ok_" + w.name]) return { ok: false, why: "Tick the box under the changes to approve them first." };
  return { ok: true, why: "" };
}
function startPage(name, p) {
  const w = name && WF[name];
  if (!w || w.deleted) {
    const list = liveWorkflows();
    return '<div class="page">' + crumbs([["Runs", "#/runs"], ["Start a workflow"]]) + '<h1 class="title">Start a workflow</h1><p class="subline">Pick the workflow to run.</p>' +
      '<div class="runlist" style="margin-top:16px">' + list.map((x) => '<div class="row"><a href="#/runs/new/' + enc(x.name) + '">' + ic("workflows") + '<span class="nm">' + esc(x.name) + '<span class="muted">' + esc(x.description || "") + "</span></span></a></div>").join("") + "</div></div>";
  }
  const v = startVals(w), st = startState(w), tried = p.tried === "1" || ui.startVals["__tried_" + w.name];
  const missing = tried && st.miss ? st.miss.map((x) => x.name) : [];
  const proj = startProj(w);
  const projFld = '<div class="fld"><label class="flab" for="in-project">Project</label><p class="help">The folder the run works in.</p>' +
    '<select id="in-project" data-start-project' + (w.where !== "home" ? " disabled" : "") + ">" + PROJECTS.map((x) => '<option value="' + x + '"' + (x === proj ? " selected" : "") + ">" + x + ", " + esc(PROJECT_PATH[x]) + "</option>").join("") + "</select>" +
    (w.where !== "home" ? '<p class="help">This file lives in ' + esc(w.where) + ", so it runs there.</p>" : "") + "</div>";
  const fields = w.inputs.map((x) => {
    const bad = missing.includes(x.name), id = "in-" + x.name;
    const input = x.type === "boolean"
      ? '<label class="chk"><input type="checkbox" id="' + id + '" data-in="' + x.name + '"' + (v[x.name] ? " checked" : "") + "><span>" + esc(x.description) + "</span></label>"
      : '<input id="' + id + '" type="' + (x.type === "number" ? "number" : "text") + '" data-in="' + x.name + '" value="' + esc(v[x.name] != null ? v[x.name] : "") + '" autocomplete="off"' + (x.required ? ' aria-required="true"' : "") + (bad ? ' aria-invalid="true" aria-describedby="em-' + x.name + '"' : "") + ">";
    const tag = x.type === "boolean" ? "span" : "label";
    return '<div class="fld' + (bad ? " err" : "") + '"><' + tag + ' class="flab"' + (tag === "label" ? ' for="' + id + '"' : "") + "><code>" + esc(x.name) + '</code><span class="req">' + (x.required ? "required" : x.def != null ? "default " + esc(JSON.stringify(x.def)) : "optional") + "</span></" + tag + ">" +
      (x.type === "boolean" ? "" : '<p class="help">' + esc(x.description) + (x.isNew && w.approved.changedSince ? ". New in the edited file." : "") + "</p>") + input +
      (bad ? '<p class="em" id="em-' + x.name + '">' + ic("warn") + "Fill in " + esc(x.name) + ". sous run refuses to start without it.</p>" : "") + "</div>";
  }).join("");
  let extra = "";
  if (w.problems) {
    const node = findSavedByLabel(w, w.problems[0].node);
    extra += '<div class="problem" role="note"><p class="pt">' + ic("warn") + "Blocked: sous check finds a problem</p><p>" + esc(w.problems[0].text) + "</p>" +
      '<div class="form-acts">' + (node ? '<a class="btn primary sm" href="#/workflows/' + enc(w.name) + '" data-step-link="' + node.id + '">Show the step</a>' : "") + '<span class="hint">Then check it again:</span>' + cmdBox("sous check " + w.path) + "</div></div>";
  }
  if (w.startedBy === "people") extra += '<div class="note muted-ic">' + ic("user") + '<div class="grow">Only people start ' + esc(w.name) + ". You start it here, so the run shows you as the one who started it.</div></div>";
  let changes = "";
  if (w.approved.changedSince) changes = sec("chg-h", "Changes since you approved it", '<p class="hint">' + esc(w.approved.editedBy.charAt(0).toUpperCase() + w.approved.editedBy.slice(1)) + " edited it " + timeEl(w.approved.editedAt) + ".</p>" + diffBlock(w.approvedText, w.text, w.path) +
    '<label class="chk"><input type="checkbox" id="start-ok" data-start-ok' + (ui.startVals["__ok_" + w.name] ? " checked" : "") + "><span>I read the changes. Approve them for every later run, then start.</span></label>");
  const btn = w.approved.changedSince ? "Approve and start" : "Start";
  return '<div class="page">' + crumbs([["Runs", "#/runs"], ["Start"], [w.name]]) +
    '<div class="head"><div class="grow"><h1 class="title">Start ' + esc(w.name) + '</h1><p class="subline">' + esc(w.description || "") + '</p><p class="pathline"><a class="lnk" href="#/workflows/' + enc(w.name) + '">' + pathHtml(w.path) + "</a></p></div></div>" +
    extra + '<form class="form" data-start="' + esc(w.name) + '" novalidate>' + projFld + fields +
    changes + '<div class="cmdline"><p class="hint">The same start from a terminal</p><span class="cmd"><code id="start-cmd">' + esc(startCmd(w)) + '</code><button type="button" class="copy" data-copy-start aria-label="Copy the command">' + I.copy + "</button></span></div>" +
    '<div class="form-acts"><button class="btn' + (w.problems ? "" : " primary") + '" type="submit" id="start-go"' + (w.problems ? " disabled" : downAttr()) + ">" + I.play + btn + '</button><a class="btn quiet" href="#/workflows/' + enc(w.name) + '">Cancel</a><span class="hint" id="start-why" role="status">' + esc(st.ok ? "" : st.why) + "</span></div></form></div>";
}
function savedToRun(x, first) {
  const o = first.done ? { s: "queued" } : (first.done = true, { s: "running", live: "generic", tok: 0, acts: [] });
  switch (x.t) {
    case "step":
      if (x.kind === "agent") return A(x.label, x.agent, x.model ? Object.assign(o, { model: x.model }) : o);
      if (x.kind === "ask") return Ask(x.label, { s: "queued" });
      if (x.kind === "checkpoint") return Ck(x.label, { s: "queued" });
      if (x.kind === "choose") return Ch(x.label, { s: "queued" });
      if (x.kind === "workflow") return C("js", x.label, "workflow(\"" + x.wf + "\")", { s: "queued" });
      return C(x.kind, x.label, x.cmd, o.s === "running" ? { s: "running" } : o);
    case "gate": return Gate(x.label, x.max, [], { s: "queued" });
    case "retry": return Retry(x.label, x.max, [], { s: "queued" });
    case "par": return Par(x.label, x.branches.map((b) => savedToRun(b[0], first)), {});
    case "pipe": return Pipe(x.label, [], { s: "queued" });
    case "bp": return Bp(x.title, x.body.map((b) => savedToRun(b, first)), { s: "queued" });
  }
  return null;
}
function doStart(w) {
  const st = startState(w);
  if (!st.ok) { ui.startVals["__tried_" + w.name] = true; route({ keepScroll: true }); const f = $(".fld.err input"); if (f) f.focus(); return; }
  const cmd = startCmd(w), v = startVals(w), inputs = {};
  w.inputs.forEach((x) => { if (v[x.name] != null && String(v[x.name]).trim() !== "") inputs[x.name] = x.type === "number" ? Number(v[x.name]) : v[x.name]; });
  if (w.approved.changedSince) { w.approved = { at: Date.now(), by: "you" }; w.approvedText = w.text; w.approvedGraph = w.graph; }
  const first = {}, tree = w.graph.map((x) => savedToRun(x, first)).filter(Boolean);
  const id = "r-" + Math.random().toString(36).slice(2, 8);
  const label = v.ticket || (v.pr ? "PR " + v.pr : v.test || (v.since ? "since " + v.since : v.team ? "team " + v.team : w.inputs[0] ? w.inputs[0].name + " " + v[w.inputs[0].name] : w.name));
  const run = buildRun({ id, wf: w.name, project: startProj(w), label: String(label), by: "you, from this view", status: "running", ago: 2 * SEC, inputs, tree });
  RUNS.unshift(run);
  delete ui.startVals[w.name]; delete ui.startVals["__tried_" + w.name]; delete ui.startVals["__ok_" + w.name];
  toast("Started " + w.name, cmd);
  location.hash = "#/runs/" + id;
}
function updateStart(w) {
  const st = startState(w), c = $("#start-cmd"), why = $("#start-why");
  if (c) c.textContent = startCmd(w);
  if (why) why.textContent = st.ok ? "" : st.why;
}

/* ------------------------------------------------------------------ agent page */
const HNAME = { claude: "Claude Code", codex: "Codex" };
/* One setting on one harness, as text for comparing and html for showing. */
function settingVal(def, h, field) {
  const f = agentField(def, h, field), none = (t) => ({ t, html: noneVal(t) });
  const links = (xs, kind) => xs.map((x) => (kind === "mcp" && !MCPS[x] ? esc(x) : '<a class="lnk" href="#/' + kind + "/" + enc(x) + '">' + esc(x) + "</a>")).join(", ");
  if (field === "tools" && h === "codex") return { t: "every tool", html: "Every tool" };
  if (field === "skills" && h === "codex") return { t: "codex skills", html: "Every skill in ~/.codex/skills" };
  if (!f) return ["model", "effort", "permissionMode", "sandbox"].includes(field) ? none("Default") : field === "tools" ? { t: "every tool", html: "Every tool" } : none("None");
  if (field === "skills") return { t: f.v.join(), html: links(f.v, "skills") };
  if (field === "mcpServers") return { t: f.v.join(), html: links(f.v, "mcp") };
  if (field === "tools") return { t: f.v.join(), html: esc(f.v.join(", ")) };
  return { t: String(f.v), html: esc(f.v) };
}
/* The file sous reads, as rulesync, Claude Code or Codex writes it. Raw shows it. */
const fmtOf = (folder) => /codex/.test(folder.id) ? "codex" : /claude/.test(folder.id) ? "claude" : "rulesync";
function agentFileText(name, def, fmt) {
  const list = (v) => Array.isArray(v) ? "[" + v.join(", ") + "]" : v;
  if (fmt === "codex") {
    const b = def.codexcli || {};
    return 'name = "' + name + '"\ndescription = "' + def.description + '"\nmodel = "' + b.model + '"' + (b.effort ? '\nmodel_reasoning_effort = "' + b.effort + '"' : "") +
      (b.sandbox ? '\nsandbox_mode = "' + b.sandbox + '"' : "") + '\ndeveloper_instructions = """\n' + def.body + '\n"""';
  }
  if (fmt === "claude") {
    const b = def.claudecode || {};
    return "---\nname: " + name + "\ndescription: " + def.description + "\nmodel: " + b.model + (b.effort ? "\neffort: " + b.effort : "") +
      (b.tools ? "\ntools: " + b.tools.join(", ") : "") + (b.skills ? "\nskills: " + list(b.skills) : "") + (b.mcpServers ? "\nmcpServers: " + list(b.mcpServers) : "") + "\n---\n" + def.body;
  }
  const y = (o, ind, codex) => Object.entries(o || {}).filter(([, v]) => v != null).map(([k, v]) => ind + (codex && k === "effort" ? "model_reasoning_effort" : k) + ": " + list(v)).join("\n");
  let t = "---\nname: " + name + "\ndescription: " + def.description + '\ntargets: ["*"]\n';
  if (def.top) t += y(def.top, "") + "\n";
  if (def.claudecode) t += "claudecode:\n" + y(def.claudecode, "  ") + "\n";
  if (def.codexcli) t += "codexcli:\n" + y(def.codexcli, "  ", true) + "\n";
  return t + "sous:\n  harness: " + def.harness + "\n---\n" + def.body;
}
/* Where sous looks for an agent, in order. It opens from the details, in a dialog. */
function agentLookupDialog(name) {
  const res = resolveAgent(name, ui.from), w = res.winner;
  const rows = FOLDERS.map((f) => {
    const pr = res.present.find((x) => x.folder === f), hit = pr.copy && pr === w;
    const fpath = pr.copy ? agentPath(f, name, ui.from) : (f.project ? PROJECT_PATH[ui.from] + "/" : "") + f.dir;
    return '<div class="lk' + (hit ? " hit" : "") + '"><span class="fl">' + esc(f.label) + '</span><span class="p">' + pathHtml(fpath) + '</span><span class="s">' + (hit ? "used" : pr.copy ? "not used" : "none") + "</span></div>";
  }).join("");
  openDialog('<h2 id="dlg-h">Where sous looks for ' + esc(name) + "</h2><p>Seen from " + esc(ui.from) + ". Project folders come first, then home. In one place, the Claude Code copy comes before the Codex one. The first copy found is the one sous uses.</p>" +
    '<div class="lkl">' + rows + '</div><div class="acts"><button class="btn" data-dlg="cancel" data-autofocus>Close</button></div>', "Where sous looks");
}
function agentPage(name, p) {
  const res = resolveAgent(name, ui.from);
  if (!res.winner) return '<div class="page">' + crumbs([["Agents", "#/agents"], [name]]) + '<div class="empty"><h1 class="title">' + esc(name) + '</h1><p>Seen from ' + esc(ui.from) + ", sous finds no copy of " + esc(name) + ". Pick another project in Seen from.</p></div></div>";
  const w = res.winner, def = copyDef(res.def, w), hs = agentHarness(def);
  const dflt = def.codexOnly || (def.harness === "codex" && !def.claudeOnly) ? "codex" : "claude", other = dflt === "claude" ? "codex" : "claude";
  const both = hs === "both";
  const path = agentPath(w.folder, name, ui.from), fmt = fmtOf(w.folder), users = agentUsers(name);
  /* one value, and the other harness's value under it only where it differs */
  const setting = (field, otherField) => {
    const a = settingVal(def, dflt, field);
    if (!both) return a.html;
    const b = settingVal(def, other, otherField || field);
    return a.html + (otherField || a.t !== b.t ? factSub(HNAME[other] + (otherField ? " " + (otherField === "sandbox" ? "sandbox" : "permission mode") : "") + ": " + b.html) : "");
  };
  const permField = dflt === "claude" ? "permissionMode" : "sandbox", permOther = dflt === "claude" ? "sandbox" : "permissionMode";
  const skills = (agentField(def, "claude", "skills") || { v: [] }).v;
  const noCodex = both ? skills.filter((s) => SKILLS[s] && !SKILLS[s].where.includes("h-codex")) : [];
  const mcps = (agentField(def, def.codexOnly ? "codex" : "claude", "mcpServers") || { v: [] }).v;
  let banners = "";
  mcps.filter((s) => !MCPS[s]).forEach((s) => {
    banners += banner("bad", "warn", '<span class="bt">No MCP server named ' + esc(s) + ".</span> " + esc(name) + " lists it, but no mcp.jsonc sous reads has it, so its steps run without it. sous check reports it.");
  });
  const usedBy = users.length ? linkList(users.map((u) => '<span><a class="lnk" href="#/workflows/' + enc(u.wf) + '" data-step-link="' + u.id + '">' + esc(u.label.replace(/\{(\w+)\}/g, "$1")) + '</a><span class="muted"> in ' + esc(u.wf) + "</span></span>")) : noneVal("No step");
  const copies = res.hidden.map((x) => {
    const xp = agentPath(x.folder, name, ui.from);
    return '<span class="ocopy"><code tabindex="0" data-tip="' + esc(xp) + '">' + esc(xp.split("/").pop()) + "</code>" + factSub(esc(x.folder.label) + ", not used") + "</span>";
  });
  const lookupBtn = '<button class="lnk-btn small" data-lookup="' + esc(name) + '">Where sous looks</button>';
  const facts = [
    fact("Runs on", both ? "Claude Code and Codex" + factSub(HNAME[dflt] + " unless a step picks " + HNAME[other]) : esc(hs) + " only" + factSub("It lives in " + esc(w.folder.dir))),
    fact("Model", setting("model")),
    fact("Effort", setting("effort")),
    fact(dflt === "claude" ? "Permission mode" : "Sandbox", setting(permField, both ? permOther : null)),
    fact("Skills", dflt === "codex" ? settingVal(def, "codex", "skills").html + (both ? factSub("Claude Code: " + settingVal(def, "claude", "skills").html) : "")
      : settingVal(def, "claude", "skills").html + (both ? factSub("Codex: every skill in ~/.codex/skills" + (noCodex.length ? ", which has no " + noCodex.map(esc).join(" or ") : "")) : "")),
    fact("Used by", usedBy),
    fact("File", fileVal(path, esc(w.folder.label))),
    fact("Other copies", (copies.length ? linkList(copies) : noneVal()) + '<span class="sub">' + lookupBtn + "</span>"),
  ];
  const seen = '<label class="pick narrow-only">Seen from <select data-from aria-label="Seen from">' + PROJECTS.map((x) => '<option value="' + x + '"' + (ui.from === x ? " selected" : "") + ">" + x + "</option>").join("") + "</select></label>";
  /* prompt, tools and MCP servers make the agent, so they sit in the content column */
  const toolsOf = (h) => {
    const f = h === "codex" ? null : agentField(def, h, "tools");
    return f && f.v.length ? '<span class="toks">' + f.v.map((t) => '<code class="tok">' + esc(t) + "</code>").join("") + "</span>"
      : "<span>Every tool" + (h === "codex" ? ". Codex agents have no tool list." : "") + "</span>";
  };
  const hasList = (h) => h !== "codex" && ((agentField(def, h, "tools") || { v: [] }).v.length > 0);
  const toolsBody = both && hasList(dflt) !== hasList(other)
    ? '<dl class="kv agkv"><dt>' + HNAME[dflt] + "</dt><dd>" + toolsOf(dflt) + "</dd><dt>" + HNAME[other] + "</dt><dd>" + toolsOf(other) + "</dd></dl>"
    : toolsOf(dflt);
  const mcpNote = (s, m) => {
    if (!m) return "No mcp.jsonc sous reads has it, so steps run without it";
    if (m.project && m.project !== ui.from) return "Only " + esc(m.project) + " has it";
    if (both && m.also) return "On Codex steps it runs as " + esc(s) + "_step";
    return "";
  };
  const mcpBody = mcps.length
    ? '<dl class="kv agkv">' + mcps.map((s) => {
        const m = MCPS[s], note = mcpNote(s, m);
        const how = !m ? '<span class="muted">Not found</span>' : m.type === "http" ? "http <code>" + esc(m.url) + "</code>" : "stdio <code>" + esc([m.command].concat(m.args || []).join(" ")) + "</code>";
        return "<dt>" + (m ? '<a class="lnk" href="#/mcp/' + enc(s) + '">' + esc(s) + "</a>" : esc(s)) + "</dt><dd>" + how + (note ? '<span class="sub">' + note + "</span>" : "") + "</dd>";
      }).join("") + "</dl>"
    : '<p class="muted">None</p>';
  const pkey = "agent:" + name + ":" + ui.from;
  return dpage({
    crumbs: crumbs([["Agents", "#/agents"], [name]]), title: name, desc: def.description, actions: seen, banners, facts,
    content: mdBlock(pkey, def.body, { label: "Prompt", rawText: agentFileText(name, def, fmt), mode: fmt === "codex" ? "toml" : "md" }) +
      dsec("ag-tools", "Tools", toolsBody) + dsec("ag-mcp", "MCP servers", mcpBody),
  });
}
/* ------------------------------------------------------------------ skill page */
function skillPage(name) {
  const k = SKILLS[name], key = "skill:" + name, first = SKILL_FOLDERS[k.where[0]];
  const listers = Object.keys(AGENT_DEFS).filter((a) => { const r = resolveAgent(a, ui.from); if (!r.winner) return false; const d = copyDef(r.def, r.winner); return !d.codexOnly && (agentField(d, "claude", "skills") || { v: [] }).v.includes(name); });
  const codexAgents = Object.keys(AGENT_DEFS).filter((a) => { const r = resolveAgent(a, ui.from); return r.winner && !copyDef(r.def, r.winner).claudeOnly; });
  const onCodex = k.where.includes("h-codex");
  const without = onCodex ? [] : listers.filter((a) => !effDef(a, ui.from).claudeOnly);
  /* one short row per place: its name, then a check or "missing" */
  const copies = '<span class="crows">' + Object.keys(SKILL_FOLDERS).map((id) => {
    const f = SKILL_FOLDERS[id], has = k.where.includes(id), path = f.dir + name + "/SKILL.md";
    return '<span class="crow' + (has ? "" : " miss") + '"><span class="cl" tabindex="0" data-tip="' + esc(has ? path + ". " + f.note + "." : "No " + path + ".") + '">' + esc(f.label) + "</span>" +
      (has ? '<span class="ck" role="img" aria-label="has a copy">' + I.ok + "</span>" : '<span class="cm">missing</span>') + "</span>";
  }).join("") + "</span>";
  const banners = without.length ? banner("warn", "info", '<span class="bt">Not in ~/.codex/skills.</span> ' + esc(without.join(" and ")) + (without.length > 1 ? " list" : " lists") + " it, but run" + (without.length > 1 ? "" : "s") + " without it on Codex.") : "";
  const agentLinks = listers.map((a) => '<a class="lnk" href="#/agents/' + enc(a) + '">' + esc(a) + "</a>");
  const used = agentLinks.length ? linkList(agentLinks) + (onCodex ? factSub("and the " + codexAgents.length + " agents that run on Codex") : "")
    : onCodex ? "The " + codexAgents.length + " agents that run on Codex" : noneVal("No agent");
  return dpage({
    crumbs: crumbs([["Skills", "#/skills"], [name]]), title: name, desc: k.description, banners,
    facts: [fact("Copies", copies), fact("Used by", used), fact("File", fileVal(first.dir + name + "/SKILL.md", esc(first.label)))],
    content: mdBlock(key, k.text, { label: "SKILL.md" }),
  });
}

/* ------------------------------------------------------------------ MCP page */
function secretVal(v) {
  const m = String(v).match(/\$\{(\w+)\}/);
  if (!m) return "<code>" + esc(v) + '</code><span class="sub">written in the file</span>';
  return '<span class="secret" aria-label="hidden value">' + esc(v.replace(m[0], "••••••••")) + '</span><span class="sub">' + esc(m[1]) + " from ~/.sous/secrets.env</span>";
}
function mcpJson(name, m) {
  const o = m.type === "stdio" ? { type: "stdio", command: m.command, args: m.args } : { type: "http", url: m.url };
  if (m.env && m.env.length) o.env = Object.fromEntries(m.env);
  if (m.headers && m.headers.length) o.headers = Object.fromEntries(m.headers);
  return "{\n  \"mcpServers\": {\n    \"" + name + "\": " + JSON.stringify(o, null, 2).split("\n").join("\n    ") + "\n  }\n}";
}
function mcpPage(name) {
  const m = MCPS[name], rows = [];
  const add = (k, v) => rows.push("<dt>" + k + "</dt><dd>" + v + "</dd>");
  const pairs = (m.type === "stdio" ? m.env : m.headers) || [];
  const secrets = pairs.filter(([, v]) => /\$\{/.test(v)).length;
  add("Type", m.type === "stdio" ? "stdio, sous starts it" : "http, sous connects to it");
  if (m.type === "stdio") add("Command", "<code>" + esc(m.command + " " + m.args.join(" ")) + "</code>");
  else add("URL", "<code>" + esc(m.url) + "</code>");
  pairs.forEach(([k, v]) => add("<code>" + esc(k) + "</code>", secretVal(v)));
  if (m.also) add("On Codex", "Runs as <code>" + esc(name) + "_step</code>" + '<span class="sub">~/.codex/config.toml also has a server named ' + esc(name) + ". That one is off for the step.</span>");
  const agents = Object.keys(AGENT_DEFS).filter((a) => { const r = resolveAgent(a, ui.from); if (!r.winner) return false; const d = copyDef(r.def, r.winner); return ((agentField(d, d.codexOnly ? "codex" : "claude", "mcpServers") || { v: [] }).v).includes(name); });
  const steps = [];
  WORKFLOWS.forEach((w) => { if (!w.deleted) walkSaved(w.graph, (x) => { if (x.mcp && x.mcp.includes(name)) steps.push('<a class="lnk" href="#/workflows/' + enc(w.name) + '" data-step-link="' + x.id + '">' + esc(x.label) + '</a><span class="muted"> in ' + esc(w.name) + "</span>"); }); });
  const seenHere = !m.project || m.project === ui.from;
  const banners = seenHere ? "" : banner("warn", "info", '<span class="bt">Not seen from ' + esc(ui.from) + ".</span> Only " + esc(m.project) + " has this server, so a step that runs in " + esc(ui.from) + " goes without it.");
  const usedBy = '<dl class="kv">' +
    "<dt>Agents</dt><dd>" + (agents.length ? agents.map((a) => '<a class="lnk" href="#/agents/' + enc(a) + '">' + esc(a) + "</a>").join(", ") : noneVal("No agent lists it")) + "</dd>" +
    "<dt>Steps</dt><dd>" + (steps.length ? '<span class="vlist">' + steps.map((s) => "<span>" + s + "</span>").join("") + "</span>" : noneVal("No step adds it")) + "</dd></dl>";
  /* the raw file folds behind one button, so the page keeps what sous does with it first */
  const raw = '<details class="mcp-raw"><summary class="btn sm"><span class="c">Show in file</span><span class="o">Hide the file</span></summary>' +
    codeBlock(mcpJson(name, m), { path: m.from, label: "mcp.jsonc", mode: "js" }) + "</details>";
  const seen = '<label class="pick narrow-only">Seen from <select data-from aria-label="Seen from">' + PROJECTS.map((x) => '<option value="' + x + '"' + (ui.from === x ? " selected" : "") + ">" + x + "</option>").join("") + "</select></label>";
  return dpage({
    crumbs: crumbs([["MCP servers", "#/mcp"], [name]]), title: name, actions: seen, banners,
    facts: [
      fact("Seen by", m.project ? esc(m.project) + " only" : "Every project"),
      fact("Source", esc(m.source)),
      fact("Secrets", secrets ? '<span class="num">' + secrets + "</span>" + factSub("in ~/.sous/secrets.env") : noneVal()),
      fact("File", fileVal(m.from)),
    ],
    content: dsec("mcp-con", "Connection", '<dl class="kv">' + rows.join("") + "</dl>" + (secrets ? '<p class="hint dret">sous fills each ${NAME} when a step starts. Neither this page nor the agent sees the value.</p>' : "")) +
      dsec("mcp-used", "Used by", usedBy) + '<div class="dsec">' + raw + "</div>",
  });
}
/* ------------------------------------------------------------------ settings */
function settingsPage() {
  const keys = [["/", "Search runs, workflows, agents, skills and MCP servers"], [KEY_MOD + "B", "Hide or show the sidebar"], ["Esc", "Close the top overlay"], ["g r", "Go to runs"], ["g w", "Go to workflows"], ["g a", "Go to agents"], ["g s", "Go to skills"], ["g m", "Go to MCP servers"], ["j k", "Next and previous row in the list"]];
  return '<div class="page">' + crumbs([["Settings"]]) + '<h1 class="title">Settings</h1>' +
    sec("set-srv", "sous serve", '<dl class="kv"><dt>Address</dt><dd><code>http://localhost:4317</code></dd><dt>Home</dt><dd><code>~/.sous</code></dd><dt>Projects</dt><dd>' + PROJECTS.map((x) => "<code>" + esc(PROJECT_PATH[x]) + "</code>").join("<br>") + "</dd></dl>" + '<p class="hint">If the page stops updating, start the service again from a terminal.</p>' + cmdBox("sous serve")) +
    sec("set-keys", "Keyboard", '<dl class="kv">' + keys.map(([k, l]) => "<dt>" + k.split(" ").map((x) => "<kbd>" + esc(x) + "</kbd>").join(" ") + "</dt><dd>" + l + "</dd>").join("") + "</dl>") + "</div>";
}

/* ------------------------------------------------------------------ after each draw */
function afterRender(r, prev) {
  const titles = { runs: "Runs", workflows: "Workflows", agents: "Agents", skills: "Skills", mcp: "MCP servers", settings: "Settings" };
  document.title = (r.id ? r.id + ", " : "") + (titles[r.sec] || "sous") + ", sous view";
  // A graph opens at 100%, laid out so every node shows (fitGraphs). Only when it is zoomed in past its box
  // does the box scroll, and only when the selected node, or else the first that needs you or failed, is out of view.
  fitGraphs();
  $$(".gwrap").forEach((w) => {
    const sc = $(".gscroll", w), z = ui.zoom[w.getAttribute("data-gkey")] || 1;
    if (!sc) return;
    const node = $(".gnode.sel", w) || $$(".gnode.needs, .gnode.bad", w).sort((a, b) => (a.classList.contains("needs") ? 0 : 1) - (b.classList.contains("needs") ? 0 : 1) || a.offsetLeft - b.offsetLeft)[0];
    if (!node) return;
    const l = node.offsetLeft * z, r = (node.offsetLeft + node.offsetWidth) * z, t = node.offsetTop * z, b = (node.offsetTop + node.offsetHeight) * z;
    if (l < sc.scrollLeft || r > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = Math.max(0, l - 24);
    if (t < sc.scrollTop || b > sc.scrollTop + sc.clientHeight) sc.scrollTop = Math.max(0, t - 24);
    gEdges(w);
  });
  const same = prev && prev.sec === r.sec && prev.id === r.id;
  if (r.params.step && !(same && prev.params.step === r.params.step)) {
    const el = $("#drop-" + r.params.step) || $(".gnode.sel") || $("#insp");
    if (el) { const target = el.id && el.id.startsWith("drop-") ? el.previousElementSibling : el; if (target && target.scrollIntoView) target.scrollIntoView({ block: "center" }); }
  }
}

/* ------------------------------------------------------------------ menus */
function openMenu(btn) {
  const kind = btn.getAttribute("data-menu"), m = $("#menu");
  let items = [];
  if (kind === "run") {
    const run = runById(ui.route.id);
    if (!run) return;
    const done = ["done", "failed", "stopped"].includes(run.status);
    items = [["copy-id", "copy", "Copy the run id"], ["rerun", "play", "Run again with these inputs"]];
    if (run.status === "running") items.push(["pause-run", "pause", "Pause"]);
    items.push(["open-wf", "workflows", "Open the workflow"], null, done ? ["remove-run", "trash", "Remove from the list", true] : ["remove-run-off", "trash", "Remove from the list, once it ends", false, true]);
  } else if (kind === "wf") {
    items = [["copy-path", "copy", "Copy the path"], ["check-wf", "ok", "Check the file"], null, ["delete-wf", "trash", "Delete file", true]];
  }
  m.innerHTML = '<div role="menu" aria-label="More actions">' + items.map((x) => x ? '<button class="mi' + (x[3] ? " danger" : "") + '" role="menuitem" data-act="' + x[0] + '"' + (x[4] ? ' disabled aria-disabled="true" style="opacity:.5"' : "") + ">" + I[x[1]] + esc(x[2]) + "</button>" : '<div class="msep" role="separator"></div>').join("") + "</div>";
  m.setAttribute("data-for", kind === "wf" ? btn.getAttribute("data-wf") : ui.route.id);
  placePop(m, btn);
  btn.setAttribute("aria-expanded", "true");
  setPopReturn(btn);
  const f = $(".mi:not([disabled])", m);
  if (f) f.focus();
}
function confirmDialog(title, text, okLabel, onOk) {
  openDialog('<h2 id="dlg-h">' + esc(title) + "</h2><p>" + text + '</p><div class="acts"><button class="btn" data-dlg="cancel" data-autofocus>Cancel</button><button class="btn danger" data-dlg="ok">' + esc(okLabel) + "</button></div>");
  dlgOk = onOk;
}
let dlgOk = null;
/* The "Removed" row names the run and offers Undo for 8 seconds, then leaves the list. */
let goneTimer = null;
function removeRun(id) {
  ui.removed.add(id); ui.gone = id;
  route({ keepScroll: true, keepCol: true });
  refocus('#col [data-unremove="' + id + '"]');
  clearTimeout(goneTimer);
  goneTimer = setTimeout(() => {
    if (ui.gone !== id) return;
    const rows = $$("#col .row"), at = rows.findIndex((x) => x.classList.contains("gone"));
    const had = document.activeElement && document.activeElement.matches('[data-unremove="' + id + '"]');
    ui.gone = null;
    if (ui.route.sec === "runs" && ui.route.id === id) route({ keepScroll: true, keepCol: true }); else renderCol();
    /* focus was on Undo: it goes to the row that took its place */
    if (had) { const next = $$("#col .row > a")[at] || $("#col h2"); if (next) next.focus(); }
  }, 8000);
}
function unremoveRun(id) {
  clearTimeout(goneTimer);
  ui.removed.delete(id); ui.gone = null;
  route({ keepScroll: true, keepCol: true });
  refocus('#col a[href="#/runs/' + id + '"]');
}

/* ------------------------------------------------------------------ events */
const curRun = () => ui.route && ui.route.sec === "runs" && runById(ui.route.id);
const nodeById = (run, id) => run && run.flat.find((n) => n.id === id);
function refocus(sel) { const el = $(sel); if (el) el.focus(); }
const CHANGES_RUN = ["stop", "resume", "resume-step", "stop-step", "pause-run"];
function doAct(act, el) {
  const run = curRun();
  if (CHANGES_RUN.includes(act) && downBlock()) { closePops(); return; }
  switch (act) {
    case "jump-needs": { const f = $("#needs textarea, #needs input, #needs .ctl button"); if (f) { f.scrollIntoView({ block: "center" }); f.focus(); } return; }
    /* the graph or the activity asks sous serve again, and this time the answer comes */
    case "retry-load": {
      const feed = ui.mode === "feederr", step = ui.route.params.step;
      setParams({ state: null });
      toast(feed ? "The activity loaded" : "The graph loaded");
      refocus(feed && step ? '[data-step="' + step + '"]' : ".gnode");
    } return;
    case "stop": if (!run) return; closePops();
      return confirmDialog("Stop " + run.id + "?", "The running steps stop, and the steps after them do not run. sous keeps the record, so you can still read it.", "Stop the run", () => { stopRun(run); route({ keepScroll: true }); toast("Run stopped", "sous stop " + run.id); });
    case "resume": if (!run) return; { const cmd = "sous resume " + run.id + (run.pause && run.pause.reason === "budget" ? " --budget 400k" : ""); resumeRun(run); route({ keepScroll: true }); toast("Resumed", cmd); refocus("#run-status"); } return;
    case "resume-step": { const n = nodeById(run, el.getAttribute("data-node")); if (!n) return; resumeRun(run, n); route({ keepScroll: true }); toast("Resumed from " + n.label, "sous resume " + run.id + " --step " + shq(n.label)); refocus('[data-step="' + n.id + '"]'); } return;
    case "stop-step": { const n = nodeById(run, el.getAttribute("data-node")); if (!n) return; n.status = "stopped"; n.end = runElapsed(run); settle(run); route({ keepScroll: true }); toast("Stopped " + n.label, "sous stop " + run.id + " --step " + shq(n.label)); } return;
    case "sendback-open": { const id = el.getAttribute("data-node"), k = "sb" + (run ? run.id : "") + id; ui.lookOpen[k] = !ui.lookOpen[k]; route({ keepScroll: true }); refocus("#sb-" + id); } return;
    case "copy-id": closePops(); return copyText($("#menu").getAttribute("data-for"));
    case "rerun": { closePops(); if (!run) return; ui.startVals[run.wf] = Object.assign({}, run.inputs, { __project: run.project }); location.hash = "#/runs/new/" + enc(run.wf); } return;
    case "pause-run": closePops(); if (!run) return; run.status = "paused"; run.pausedAt = Date.now(); run.pause = { reason: "manual" };
      run.flat.forEach((n) => { if (!isGroup(n) && n.status === "running") { n.status = "paused"; n.end = run.pausedAt - run.startedAt; } }); restatus(run.tree); route({ keepScroll: true }); toast("Paused", "sous pause " + run.id); return;
    case "open-wf": closePops(); if (run) location.hash = "#/workflows/" + enc(run.wf); return;
    case "remove-run": closePops(); if (run) removeRun(run.id); return;
    case "copy-path": { closePops(); const w = WF[$("#menu").getAttribute("data-for")]; if (w) copyText(w.path); } return;
    case "check-wf": { closePops(); const w = WF[$("#menu").getAttribute("data-for")]; if (w) toast(w.problems ? "sous check finds 1 problem" : "sous check finds no problem", "sous check " + w.path); } return;
    case "delete-wf": {
      closePops();
      const w = WF[$("#menu").getAttribute("data-for")];
      if (!w) return;
      confirmDialog("Delete " + w.name + ".js?", "This moves <code>" + esc(w.path) + "</code> to the Trash. Its runs stay in the list. Agents can no longer start it.", "Delete file", () => {
        w.deleted = true; location.hash = "#/workflows";
        toast("Deleted " + w.name + ".js", null, () => { w.deleted = false; route({ keepScroll: true }); });
      });
    } return;
  }
}
function onClick(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest("[data-skip]")) { e.preventDefault(); $("#main").focus(); return; }
  if (t === $("#search")) { closeSearch(); return; }
  if (t === $("#dlg")) { closeDialog(); return; }
  if (t === $("#scrim")) { toggleCol(false); return; }
  if (!t.closest(".pop") && !t.closest("[data-states]") && !t.closest("[data-menu]") && !t.closest("[data-vmenu]")) closePops();
  const sh = t.closest("[data-side],[data-vmenu],[data-project-pick],[data-from-pick],#menu [data-group],#states [data-theme-set]");
  if (sh && shellClick(sh)) return;
  const el = t.closest("[data-x],[data-unremove],[data-undo],[data-copy],[data-copy-start],[data-md],[data-group],[data-clear-filter],[data-col],[data-search],[data-states],[data-theme-toggle],[data-theme-set],[data-reconnect],[data-step],[data-step-go],[data-fold],[data-gfold],[data-zoom],[data-open-step],[data-wf-step],[data-menu],[data-act],[data-more],[data-lookup],[data-step-link],[data-answer-btn],[data-dlg],.search .ri");
  if (!el) return;
  const a = (k) => el.getAttribute(k);
  if (el.matches(".search .ri")) { e.preventDefault(); const href = a("href"); closeSearch(); openResult(href); return; }
  if (el.hasAttribute("data-x")) { e.preventDefault(); removeRun(a("data-x")); return; }
  if (el.hasAttribute("data-unremove")) { unremoveRun(a("data-unremove")); return; }
  if (el.hasAttribute("data-undo")) { const f = undoFn; undoFn = null; $("#toast").classList.remove("on"); if (f) f(); return; }
  if (el.hasAttribute("data-copy")) { copyText(a("data-copy")); return; }
  if (el.hasAttribute("data-copy-start")) { copyText($("#start-cmd").textContent); return; }
  if (el.hasAttribute("data-md")) { const [k, v] = a("data-md").split("|"); ui.md[k] = v; route({ keepScroll: true, keepCol: true }); refocus('[data-md="' + k + "|" + v + '"]'); return; }
  if (el.hasAttribute("data-group")) { ui.groupBy = a("data-group"); store.set("groupBy", ui.groupBy); renderCol(); refocus('[data-group="' + ui.groupBy + '"]'); return; }
  if (el.hasAttribute("data-clear-filter")) { ui.q[ui.route.sec] = ""; ui.project = ""; setParams({ q: null, project: null }, { keepCol: true }); return; }
  if (el.hasAttribute("data-col")) { toggleCol(!ui.colOpen); return; }
  if (el.hasAttribute("data-search")) { openSearch(""); return; }
  if (el.hasAttribute("data-states")) {
    const p = $("#states");
    if (!p.hidden) { closePops(); return; }
    closePops(); renderStates(); placePop(p, el, { side: true }); el.setAttribute("aria-expanded", "true"); setPopReturn(el);
    const f = $(".mi.cur", p) || $(".mi", p); if (f) f.focus();
    return;
  }
  if (el.hasAttribute("data-theme-toggle")) { ui.theme = { auto: "light", light: "dark", dark: "auto" }[ui.theme]; store.set("theme", ui.theme); applyTheme(); renderRail(); refocus("[data-theme-toggle]"); toast("Theme: " + (ui.theme === "auto" ? "match the system" : ui.theme)); return; }
  if (el.hasAttribute("data-theme-set")) { ui.theme = a("data-theme-set"); store.set("theme", ui.theme); applyTheme(); route({ keepScroll: true }); refocus('[data-theme-set="' + ui.theme + '"]'); return; }
  if (el.hasAttribute("data-reconnect")) { clearInterval(barTimer); const bar = $("#bar"); bar.className = "bar back"; bar.innerHTML = ic("ok") + '<span class="grow">Connected to sous serve again. The page shows the latest state.</span>'; barTimer = setTimeout(() => { bar.hidden = true; document.body.classList.remove("has-bar"); }, 4000); return; }
  if (el.hasAttribute("data-step")) { const id = a("data-step"); setParams({ step: ui.route.params.step === id ? null : id, view: "steps" }); refocus('[data-step="' + id + '"]'); return; }
  if (el.hasAttribute("data-step-go")) { setParams({ view: null, step: a("data-step-go") }); const d = $("#drop-" + a("data-step-go")); if (d) d.previousElementSibling.scrollIntoView({ block: "center" }); return; }
  if (el.hasAttribute("data-fold")) { const run = curRun(), n = nodeById(run, a("data-fold")); if (!n) return; ui.fold[run.id + ":" + n.id] = !foldedIn(run, n); refreshSteps(run); refocus('[data-fold="' + n.id + '"]'); return; }
  if (el.hasAttribute("data-gfold")) { const k = a("data-gfold"); ui.gfold[k] = a("aria-expanded") === "true"; route({ keepScroll: true }); refocus('[data-gfold="' + k + '"]'); return; }
  if (el.hasAttribute("data-zoom")) { zoom(el.closest(".gwrap"), a("data-zoom")); return; }
  if (el.hasAttribute("data-open-step")) { setParams({ view: "steps", step: a("data-open-step") }); const d = $("#drop-" + a("data-open-step")); if (d) { d.previousElementSibling.scrollIntoView({ block: "center" }); refocus('[data-step="' + a("data-open-step") + '"]'); } return; }
  if (el.hasAttribute("data-wf-step")) { const id = a("data-wf-step"), same = ui.route.params.step === id; setParams({ step: same ? null : id }); if (!same) { const i = $("#insp"); if (i) i.scrollIntoView({ block: "nearest" }); } refocus('[data-wf-step="' + id + '"]'); return; }
  if (el.hasAttribute("data-menu")) { const open = !$("#menu").hidden; closePops(); if (!open) openMenu(el); return; }
  if (el.hasAttribute("data-dlg")) { const ok = a("data-dlg") === "ok", f = dlgOk; dlgOk = null; closeDialog(); if (ok && f) f(); return; }
  if (el.hasAttribute("data-act")) { if (el.disabled) return; e.preventDefault(); doAct(a("data-act"), el); return; }
  if (el.hasAttribute("data-more")) { const k = a("data-more"); ui.showAll[k] = true; const run = curRun(); const n = run && run.flat.find((x) => run.id + x.id === k); const box = n && $("#acts-" + n.id); if (box) box.innerHTML = actsHtml(run, n); return; }
  if (el.hasAttribute("data-lookup")) { agentLookupDialog(a("data-lookup")); return; }
  if (el.hasAttribute("data-step-link")) { e.preventDefault(); location.hash = a("href") + "?view=steps&step=" + enc(a("data-step-link")); return; }
  if (el.hasAttribute("data-answer-btn")) {
    if (downBlock()) return;
    const run = curRun(), n = nodeById(run, a("data-answer-btn")); if (!n) return;
    const v = a("data-v");
    const cmd = answerAsk(run, n, v === "approve" ? "approved" : v, v === "approve" ? "approve" : "answer");
    route({ keepScroll: true });
    toast(v === "approve" ? "Approved" : "Answer sent", cmd);
    refocus(".note.answered .lnk-btn");
  }
}
/* An empty typed field gets a line under it, and a screen reader reads it out. Typing clears it. */
function fieldError(ta, msg) {
  const id = ta.id + "-err";
  let p = document.getElementById(id);
  if (!p) { p = document.createElement("p"); p.className = "ferr"; p.id = id; p.setAttribute("role", "alert"); ta.insertAdjacentElement("afterend", p); }
  p.innerHTML = ic("warn") + esc(msg);
  ta.setAttribute("aria-invalid", "true");
  ta.setAttribute("aria-describedby", id);
  ta.focus();
}
function clearFieldError(ta) {
  const p = document.getElementById(ta.id + "-err");
  if (p) p.remove();
  ta.removeAttribute("aria-invalid");
  ta.removeAttribute("aria-describedby");
}
function onSubmit(e) {
  const f = e.target;
  if (f.hasAttribute("data-answer")) {
    e.preventDefault();
    const run = curRun(), n = nodeById(run, f.getAttribute("data-answer")); if (!n) return;
    const ta = $("textarea", f), radio = $("input[type=radio]:checked", f);
    const v = ta ? ta.value.trim() : radio ? radio.value : "";
    if (!v) { if (ta) fieldError(ta, "Write an answer first."); return; }
    if (downBlock()) return;
    const cmd = answerAsk(run, n, v, "answer");
    route({ keepScroll: true });
    toast("Answer sent", cmd);
    refocus(".note.answered .lnk-btn");
    return;
  }
  if (f.hasAttribute("data-sendback")) {
    e.preventDefault();
    const run = curRun(), n = nodeById(run, f.getAttribute("data-sendback")); if (!n) return;
    const v = $("textarea", f).value.trim();
    if (!v) { fieldError($("textarea", f), "Write what should change first."); return; }
    if (downBlock()) return;
    const cmd = answerAsk(run, n, v, "send-back"); ui.lookOpen["sb" + run.id + n.id] = false;
    route({ keepScroll: true });
    toast("Sent back", cmd);
    return;
  }
  if (f.hasAttribute("data-tell")) {
    e.preventDefault();
    const run = curRun(), n = nodeById(run, f.getAttribute("data-tell")); if (!n) return;
    const inp = $("input", f), v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    if (downBlock()) return;
    const inTurn = (n.acts || []).some((x) => x.k !== "prompt");
    if (!inTurn) {
      ui.tellResult[run.id + n.id] = '"' + n.label + '" is not in a turn that can read a message now, such as while it starts, waits for a slot or waits between two turns. Tell it again in a moment, once a turn goes on.';
      refreshSteps(run); const i = $("#tell-" + n.id); if (i) { i.value = v; i.focus(); }
      return;
    }
    delete ui.tellResult[run.id + n.id];
    n.acts.push({ k: "tell", t: v, dlv: "pending", at: Date.now(), sentAt: Date.now() });
    inp.value = "";
    const box = $("#acts-" + n.id); if (box) box.innerHTML = actsHtml(run, n);
    toast("Message sent", "sous tell " + run.id + " --step " + shq(n.label) + " " + shq(v));
    return;
  }
  if (f.hasAttribute("data-start")) { e.preventDefault(); if (downBlock()) return; const w = WF[f.getAttribute("data-start")]; if (w) doStart(w); }
}
function onInput(e) {
  const t = e.target;
  if (t.hasAttribute("data-filter")) {
    const sec = t.getAttribute("data-filter"), pos = t.selectionStart;
    ui.q[sec] = t.value; renderCol();
    const n = $('[data-filter="' + sec + '"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* number inputs */ } }
    return;
  }
  if (t.id === "sq") { searchSel = 0; renderSearchResults(t.value); return; }
  if (t.tagName === "TEXTAREA" && t.getAttribute("aria-invalid") === "true" && t.value.trim()) { clearFieldError(t); return; }
  if (t.hasAttribute("data-in")) {
    const f = t.closest("[data-start]"), w = WF[f.getAttribute("data-start")];
    ui.startVals[w.name] = ui.startVals[w.name] || {};
    ui.startVals[w.name][t.getAttribute("data-in")] = t.type === "checkbox" ? t.checked : t.value;
    if (t.getAttribute("aria-invalid") && t.value.trim()) { t.removeAttribute("aria-invalid"); }
    updateStart(w);
  }
}
function onChange(e) {
  const t = e.target;
  if (t.hasAttribute("data-project-filter")) { ui.project = t.value; setParams({ project: t.value || null }, { keepCol: true }); refocus("[data-project-filter]"); return; }
  if (t.hasAttribute("data-from")) { const id = t.id; ui.from = t.value; setParams({ from: t.value }, { keepCol: true }); if (id) refocus("#" + id); else refocus(".page [data-from]"); return; }
  if (t.hasAttribute("data-start-project")) { const w = WF[t.closest("[data-start]").getAttribute("data-start")]; ui.startVals[w.name] = Object.assign(ui.startVals[w.name] || {}, { __project: t.value }); updateStart(w); return; }
  if (t.hasAttribute("data-start-ok")) { const w = WF[t.closest("[data-start]") ? t.closest("[data-start]").getAttribute("data-start") : ui.route.sub]; ui.startVals["__ok_" + w.name] = t.checked; updateStart(w); return; }
  if (t.hasAttribute("data-in") && t.type === "checkbox") onInput(e);
}
/* Zoom goes from 100% up to 150%, so node names never get under 13px. "Back to 100%" undoes it. */
function zoom(wrap, how) {
  const sc = wrap && $(".gscroll", wrap);
  if (!sc) return;
  const key = wrap.getAttribute("data-gkey"), W = Number(sc.getAttribute("data-w")), H = Number(sc.getAttribute("data-h"));
  let z = ui.zoom[key] || 1;
  if (how === "in") z = Math.min(1.5, z + 0.25);
  else if (how === "out") z = Math.max(1, z - 0.25);
  else z = 1;
  ui.zoom[key] = z;
  sc.classList.toggle("zoomed", z > 1);
  $(".gsizer", wrap).style.width = Math.round(W * z) + "px";
  $(".gsizer", wrap).style.height = Math.round(H * z) + "px";
  $(".gcanvas", wrap).style.transform = "scale(" + z + ")";
  $$('[data-zoom="out"], [data-zoom="fit"]', wrap).forEach((b) => { if (z <= 1) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled"); });
  const zi = $('[data-zoom="in"]', wrap); if (zi) { if (z >= 1.5) zi.setAttribute("aria-disabled", "true"); else zi.removeAttribute("aria-disabled"); }
  gEdges(wrap);
}
function toggleCol(open) {
  ui.colOpen = open;
  document.body.classList.toggle("col-open", open);
  $("#scrim").hidden = !open;
  $$("[data-col]").forEach((b) => { if (b.hasAttribute("aria-expanded")) b.setAttribute("aria-expanded", String(open)); });
  syncSideBtns();
  if (open) { const f = $("#col .col-top > :first-child, #col a"); if (f) f.focus(); } else { const b = $(".col-btn") && getComputedStyle($(".col-btn")).display !== "none" ? $(".col-btn") : $(".rail-menu"); if (b) b.focus(); }
}
let gWait = false;
function onKey(e) {
  const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  if (e.key === "Escape") {
    hideTip();
    if (closeDialog() || closeSearch()) { e.preventDefault(); return; }
    if (closePops()) { e.preventDefault(); if (t && t.closest && t.closest(".pop")) focusPopReturn(); return; }
    if (ui.colOpen) { e.preventDefault(); toggleCol(false); return; }
    if (!typing && ui.route.params.step) { const id = ui.route.params.step; setParams({ step: null }); refocus('[data-step="' + id + '"], [data-wf-step="' + id + '"]'); }
    return;
  }
  if (t && t.id === "sq") {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!searchItems.length) return; searchSel = (searchSel + (e.key === "ArrowDown" ? 1 : -1) + searchItems.length) % searchItems.length; renderSearchResults(t.value); const s = $("#sr-" + searchSel); if (s) s.scrollIntoView({ block: "nearest" }); return; }
    if (e.key === "Enter") { e.preventDefault(); const it = searchItems[searchSel]; if (it) { closeSearch(); openResult(it.href); } return; }
    return;
  }
  if (!$("#dlg").hidden) {
    if (e.key === "Tab") { const f = $$("#dlg button"); if (!f.length) return; const i = f.indexOf(document.activeElement); if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
    return;
  }
  /* ⌘B on macOS, Ctrl+B elsewhere: hide or show the list column */
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "b" || e.key === "B")) { e.preventDefault(); closePops(); toggleSidebar(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); openSearch(""); return; }
  if (gWait) { gWait = false; const s = SECTIONS.find((x) => x.key === e.key); if (s) { e.preventDefault(); location.hash = "#/" + s.id; } return; }
  if (e.key === "g") { gWait = true; setTimeout(() => { gWait = false; }, 1200); return; }
  if (e.key === "j" || e.key === "k") {
    const rows = $$("#col .col-body .row > a");
    if (!rows.length) return;
    const cur = rows.findIndex((a) => a.getAttribute("aria-current") === "page");
    const next = rows[Math.max(0, Math.min(rows.length - 1, cur + (e.key === "j" ? 1 : -1)))];
    if (next) { e.preventDefault(); location.hash = next.getAttribute("href"); }
  }
}
let tipTimer = null;
function boot() {
  applyTheme();
  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("keydown", onKey);
  document.addEventListener("mouseover", (e) => { const el = e.target instanceof Element && e.target.closest("[data-tip]"); clearTimeout(tipTimer); if (!el) { if (tipFor) hideTip(); return; } if (el === tipFor) return; tipTimer = setTimeout(() => showTip(el), 350); });
  document.addEventListener("focusin", (e) => { const el = e.target instanceof Element && e.target.closest("[data-tip]"); if (el && el.matches(":focus-visible")) showTip(el); else hideTip(); });
  document.addEventListener("focusout", hideTip);
  document.addEventListener("scroll", (e) => { hideTip(); const t = e.target; if (t instanceof Element && t.classList.contains("gscroll")) gEdges(t.closest(".gwrap")); }, true);
  let wide = window.innerWidth >= 700, fitFrame = 0;
  window.addEventListener("resize", () => {
    const w = window.innerWidth >= 700;
    if (w !== wide) { wide = w; if (ui.route) route({ keepScroll: true, keepCol: true }); }
    cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(fitGraphs);
    closePops(); hideTip(); syncSideBtns();
  });
  window.addEventListener("hashchange", () => { ui.gone = null; route(); });
  if (!location.hash || location.hash === "#" || location.hash === "#/") { try { history.replaceState(null, "", "#/runs"); } catch (e) { /* file urls */ } }
  route();
  setInterval(tick, 1000);
}
boot();
