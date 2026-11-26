/* sous view mock v3: workflow, start, agent, skill, MCP and settings pages, then menus, events and boot. */
"use strict";

const pairsHtml = (pairs) => '<dl class="pairs">' + pairs.filter((p) => p && p[1]).map(([k, v, sans]) => "<div><dt>" + k + "</dt><dd" + (sans ? ' class="' + (sans === "wrap" ? "wrap" : "sans") + '"' : "") + ">" + v + "</dd></div>").join("") + "</dl>";
const chips = (xs, icon) => xs.length ? '<div class="chips">' + xs.map(([href, label, attr]) => '<a class="chip" href="' + href + '"' + (attr || "") + ">" + ic(icon) + esc(label) + "</a>").join("") + "</div>" : '<p class="hint">None.</p>';
const sec = (id, title, body, right) => '<section class="sec" aria-labelledby="' + id + '"><div class="sec-h"><h2 id="' + id + '">' + title + "</h2>" + (right ? '<span class="r">' + right + "</span>" : "") + "</div>" + body + "</section>";
const wfCalledBy = (name) => WORKFLOWS.filter((w) => !w.deleted && wfCalls(w).includes(name)).map((w) => w.name);
const projectOf = (w) => w.where === "home" ? ui.from : w.where;

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
/* drawn the way the run graph draws the same file: a gate or retry is one node, boxes fold, an early end hangs under its step */
function savedTree(w, sel) {
  const marks = diffMarks(w);
  const leaf = (x, o) => Object.assign({ t: "leaf", id: x.id, label: savedLabel(x), kind: x.kind, d: marks[x.id] || (x.kind === "agent" ? x.agent : x.kind === "workflow" ? "workflow" : x.kind), bad: !!x.bad, sel: sel === x.id, attr: 'data-wf-step="' + x.id + '"' }, o || {});
  const seq = (xs) => {
    const items = [];
    xs.forEach((x) => { const c = conv(x); if (x.t === "dec" && items.length) items.push({ t: "exit", main: items.pop(), exit: c }); else items.push(c); });
    return { t: "seq", items };
  };
  const box = (x, o) => { const k = "wf:" + w.name + ":" + x.id; let bad = false; walkSaved([x], (y) => { if (y.bad) bad = true; }); return Object.assign({ t: "box", bad, foldKey: k, folded: k in ui.gfold ? ui.gfold[k] : false, auto: !(k in ui.gfold) }, o); };
  function conv(x) {
    switch (x.t) {
      case "step": return leaf(x, x.kind === "workflow" ? { kind: "wf" } : {});
      case "gate": case "retry": return leaf(x, { kind: x.t, d: "up to " + x.max, tip: x.label + ", " + x.t + ", up to " + plural(x.max, "attempt") });
      case "if": return box(x, { kind: "if", title: "if " + x.cond, sub: x.note, fsub: "condition", lanes: [seq(x.body)] });
      case "dec": return leaf(x, { kind: "dec", d: "ends", dec: true, tip: "If " + x.cond + ", the workflow " + x.end + "." });
      case "par": return box(x, { kind: "par", title: x.label, sub: plural(x.branches.length, "branch", "branches") + ", at once", fsub: plural(x.branches.length, "branch", "branches"), lanes: x.branches.map(seq) });
      case "pipe": return box(x, { kind: "pipe", title: "pipeline", sub: "over " + x.over, fsub: "over " + x.over, lanes: [seq(x.body)] });
      case "bp": return { t: "seq", items: x.body.map(conv).concat([leaf(x, { kind: "bp", d: "breakpoint" })]) };
    }
    return leaf(x);
  }
  return seq(w.graph);
}
function outlineHtml(w, sel) {
  const marks = diffMarks(w), rows = [];
  const walk = (xs, depth) => xs.forEach((x) => {
    const k = x.t === "step" ? x.kind : x.t;
    const d = x.t === "step" ? (x.kind === "agent" ? "agent " + x.agent : x.kind === "workflow" ? "workflow " + x.wf : x.cmd || SAVED_KIND[x.kind] || x.kind) : x.t === "dec" ? x.end : SAVED_KIND[x.t] + (x.max ? ", up to " + x.max : "") + (x.over ? " over " + x.over : "");
    rows.push('<button class="oline' + (x.bad ? " bad" : "") + (sel === x.id ? " sel" : "") + '" data-wf-step="' + x.id + '" aria-pressed="' + (sel === x.id) + '">' + '<span class="gd" aria-hidden="true"></span>'.repeat(depth) +
      ki(k === "workflow" ? "wf" : k) + '<span class="nm">' + esc(savedLabel(x)) + "</span>" + (marks[x.id] ? '<span class="tag">' + marks[x.id] + "</span>" : "") + '<span class="d">' + esc(d) + "</span></button>");
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
  add("Kind", s.t === "step" ? (s.kind === "agent" ? "agent step" : s.kind === "workflow" ? "nested workflow" : ["sh", "js", "py", "run", "waitUntil"].includes(s.kind) ? s.kind + ", a code step" : s.kind) : SAVED_KIND[s.t]);
  if (s.kind === "agent") {
    const m = savedModel(s, project), d = effDef(s.agent, project), codex = m.harness === "Codex";
    add("Agent", '<a class="lnk" href="#/agents/' + enc(s.agent) + '">' + esc(s.agent) + "</a>");
    add("Runs on", esc(m.harness) + (w.where === "home" ? '<span class="sub">seen from ' + esc(project) + "</span>" : ""));
    add("Model", "<code>" + esc(m.model) + "</code>" + (m.effort ? ", effort " + esc(m.effort) : ""));
    const sk = agentField(d, codex ? "codex" : "claude", "skills");
    add("Skills", codex ? "every skill in ~/.codex/skills" : sk ? sk.v.map((x) => '<a class="lnk" href="#/skills/' + enc(x) + '">' + esc(x) + "</a>").join(", ") : "none");
    const mc = s.mcp || (agentField(d, codex ? "codex" : "claude", "mcpServers") || {}).v;
    add("MCP", mc && mc.length ? mc.map((x) => '<a class="lnk" href="#/mcp/' + enc(x) + '">' + esc(x) + "</a>").join(", ") : "none");
  }
  if (s.kind === "workflow") add("Workflow", '<a class="lnk" href="#/workflows/' + enc(s.wf) + '">' + esc(s.wf) + "</a>" + (s.args ? ", with <code>" + esc(JSON.stringify(s.args)) + "</code>" : ""));
  if (s.cmd) add("Command", "<code>" + esc(s.cmd) + "</code>");
  if (s.q) add("Choices", esc(s.q.choices.join(", ")));
  if (s.options) add("Options", esc(s.options.join(", ")));
  if (s.max) add("Attempts", "up to " + s.max + (s.maxArg ? ", set by --" + esc(s.maxArg) : ""));
  if ((s.t === "gate" || s.t === "retry") && s.body) add("Steps inside", s.body.map((b) => '<button class="lnk-btn" data-wf-step="' + b.id + '">' + esc(savedLabel(b)) + "</button>").join(", "));
  if (s.opts && s.opts.length) add("Set in the file", "<code>" + esc(s.opts.join(", ")) + "</code>");
  const lines = findLines(w.text, s.find || 'label: "' + s.label + '"');
  return '<section class="inspector" id="insp" aria-labelledby="insp-h"><div class="sec-h"><h2 id="insp-h">' + esc(savedLabel(s)) + '</h2><span class="r"><button class="btn sm quiet" data-wf-step="' + s.id + '">' + I.x + "Close</button></span></div>" +
    stepText(s).map((t) => '<p class="body">' + esc(t) + "</p>").join("") + '<dl class="kv">' + rows.join("") + "</dl>" +
    (s.bad ? '<div class="problem"><p class="pt">' + ic("warn") + "Problem</p><p>" + esc(s.bad) + "</p></div>" : "") +
    (lines ? '<div class="part"><p class="hint">In the file, from line ' + lines.start + "</p>" + codeBlock(lines.text, { start: lines.start, label: "Lines of " + savedLabel(s) }) + "</div>" : "") + "</section>";
}

/* ------------------------------------------------------------------ workflow page */
function wfEmptyPage() {
  return '<div class="page">' + crumbs([["Workflows"]]) + '<div class="empty"><h1 class="title">No saved workflows</h1><p>sous saves a workflow the first time you approve it. A workflow is one JS file in ~/.sous/workflows or in a project\'s .sous/workflows.</p>' +
    "<p>The guide writes a first one with you.</p>" + cmdBox("sous guide") + '<p style="margin-top:16px">Or check a file you wrote, without running it.</p>' + cmdBox("sous check ./ticket.js --dry-run") + "</div></div>";
}
function wfPage(w, sub, p) {
  const a = w.approved, view = ["steps", "source", "diff"].includes(p.view) ? p.view : "graph";
  const sel = p.step && findSaved(w, p.step) ? p.step : null, s = sel && findSaved(w, sel);
  const pairs = [
    ["Lives in", w.where === "home" ? "home" : esc(w.where), true],
    ["Started by", w.startedBy === "people" ? "people only" : "people or agents", true],
    ["Works in", w.place === "worktree" ? "a worktree" : w.place === "folder" ? "the project folder" : "no folder", true],
    ["Schedule", w.schedule ? esc(w.schedule) : "none", "wrap"],
    ["Timeout", w.timeout ? esc(w.timeout) : "none"],
    /* the approval state, and when the file changed after it, the changes one click away */
    ["Approval", a.changedSince ? '<a href="#/workflows/' + enc(w.name) + '?view=diff" data-tip="' + esc("You approved it " + fmtAgo(a.at) + ". " + a.editedBy.charAt(0).toUpperCase() + a.editedBy.slice(1) + " edited it " + fmtAgo(a.editedAt) + ".") + '">Changed since you approved</a>'
      : a.seeded ? "Approved on first run" : "Approved " + timeEl(a.at) + " by " + esc(a.by), true],
  ];
  let notes = "";
  (w.problems || []).forEach((pr) => {
    const node = findSavedByLabel(w, pr.node);
    notes += '<div class="problem" role="note"><p class="pt">' + ic("warn") + "sous check finds a problem</p><p>" + esc(pr.text) + " Starting it is blocked until the file is fixed.</p>" +
      '<div class="form-acts">' + (node ? '<button class="btn primary sm" data-wf-step="' + node.id + '">Show the step</button>' : "") + '<span class="hint">Then check it again:</span>' + cmdBox("sous check " + w.path) + "</div></div>";
  });
  if (a.changedSince) notes += '<div class="note">' + ic("info") + '<div class="grow">' + esc(a.editedBy.charAt(0).toUpperCase() + a.editedBy.slice(1)) + " edited this file " + timeEl(a.editedAt) +
    ", after you approved it. sous runs the approved text until you approve the change." + (w.problems ? "" : " Start shows you the changes to approve first.") + "</div></div>";
  if (a.seeded) notes += '<div class="note muted-ic">' + ic("info") + '<div class="grow">sous approved this file as it was when it first ran here, ' + timeEl(a.at) + ". Nobody has changed it since.</div></div>";
  if (w.startedBy === "people") notes += '<div class="note muted-ic">' + ic("user") + '<div class="grow">Only people start this workflow. An agent that tries gets a refusal. Its schedule still starts it.</div></div>';
  (w.notes || []).forEach((n) => { notes += '<div class="note muted-ic">' + ic("info") + '<div class="grow">' + esc(n) + "</div></div>"; });
  const views = [["graph", "Graph"], ["steps", "Steps"], ["source", "Source"]].concat(a.changedSince ? [["diff", "Changes"]] : []);
  const viewbar = '<div class="viewbar"><nav class="seg" aria-label="View">' + views.map(([k, l]) => '<a href="#/workflows/' + enc(w.name) + (k === "graph" ? "" : "?view=" + k) + '"' + (view === k ? ' aria-current="page"' : "") + ">" + l + "</a>").join("") + "</nav>" +
    '<span class="r">' + (view === "diff" ? "Changes since you approved it" : view === "source" ? plural(w.text.split("\n").length, "line") : view === "graph" && ui.mode === "grapherr" ? "" : "Select a step to see what it does") + "</span></div>";
  let body;
  if (view === "graph") body = graphHtml(savedTree(w, sel), "wf:" + w.name, "Graph of the workflow " + w.name);
  else if (view === "steps") body = outlineHtml(w, sel);
  else if (view === "diff") body = diffBlock(w.approvedText, w.text, w.path);
  else { const L = s && findLines(w.text, s.find || 'label: "' + s.label + '"'); const hit = L ? Array.from({ length: L.text.split("\n").length }, (_, i) => L.start + i) : []; body = codeBlock(w.text, { path: w.path, copy: true, hit, label: w.name + ".js" }); }
  const ins = '<dl class="kv">' + w.inputs.map((x) => "<dt><code>" + esc(x.name) + "</code></dt><dd>" + esc(x.description) + '<span class="sub">' + esc(x.type) + (x.required ? ", required" : "") + (x.def != null ? ", default " + esc(JSON.stringify(x.def)) : "") + (x.isNew && a.changedSince ? ", new in the edited file" : "") + "</span></dd>").join("") + "</dl>" +
    (w.outputs ? '<p class="hint">Returns ' + w.outputs.map((o) => "<code>" + esc(o[0]) + "</code>, " + esc(o[1].toLowerCase())).join("; ") + ".</p>" : "");
  const runs = liveRuns().filter((r) => r.wf === w.name && !r.gen).sort((x, y) => y.startedAt - x.startedAt).slice(0, 6);
  const runRows = runs.length ? '<div class="runlist">' + runs.map((r) => runRowHtml(r, { project: true })).join("") + "</div>" : '<p class="hint">No runs yet. Start one above, or from a terminal.</p>' + cmdBox("sous run " + w.name + (w.inputs[0] && w.inputs[0].required ? " --" + w.inputs[0].name + " ..." : ""));
  const agents = [];
  walkSaved(w.graph, (x) => { if (x.agent && !agents.includes(x.agent)) agents.push(x.agent); });
  return '<div class="page">' + crumbs([["Workflows", "#/workflows"], [w.where === "home" ? "home" : w.where], [w.name]]) +
    '<div class="head"><div class="grow"><h1 class="title">' + esc(w.name) + '</h1><p class="subline">' + esc(w.description || "") + '</p><p class="pathline">' + pathHtml(w.path, "Copy the path") + "</p></div>" +
    '<div class="actions">' + (w.problems ? '<span class="hint" id="wf-blocked">Blocked until sous check passes</span><button class="btn" type="button" disabled aria-describedby="wf-blocked">' + I.play + "Start</button>"
      : '<a class="btn primary" href="#/runs/new/' + enc(w.name) + '">' + I.play + "Start</a>") +
    '<button class="ibtn bd" data-menu="wf" data-wf="' + esc(w.name) + '" aria-haspopup="true" aria-expanded="false" aria-label="More actions" data-tip="More">' + I.more + "</button></div></div>" +
    pairsHtml(pairs) + notes + viewbar + body + inspector(w, s) +
    sec("wf-in", "Inputs", ins) + sec("wf-runs", "Last runs", runRows, runs.length ? '<span class="n">' + runs.length + "</span>" : "") +
    sec("wf-ag", "Agents", chips(agents.map((x) => ["#/agents/" + enc(x), x]), "agents")) +
    sec("wf-calls", "Calls", chips(wfCalls(w).map((x) => ["#/workflows/" + enc(x), x]), "workflows")) +
    sec("wf-by", "Called by", chips(wfCalledBy(w.name).map((x) => ["#/workflows/" + enc(x), x]), "workflows")) + "</div>";
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
const HNAME = { claude: "Claude Code", codex: "Codex" };
function settingVal(def, h, field) {
  const f = agentField(def, h, field);
  const both = f && f.from === "top" ? '<span class="sub">set for both harnesses</span>' : "";
  if (field === "tools" && h === "codex") return 'every tool<span class="sub">Codex has no allow list. The sandbox limits what it does.</span>';
  if (field === "skills" && h === "codex") return 'every skill in ~/.codex/skills<span class="sub">Codex has no skills list.</span>';
  if (field === "sandbox" && h === "claude") return '<span class="muted">not a Claude Code setting</span>';
  if (field === "permissionMode" && h === "codex") return '<span class="muted">not a Codex setting</span>';
  if (!f) return '<span class="muted">' + (["model", "effort", "sandbox", "permissionMode"].includes(field) ? "default" : "none") + "</span>";
  if (field === "skills") return f.v.map((x) => '<a class="lnk" href="#/skills/' + enc(x) + '">' + esc(x) + "</a>").join(", ") + both;
  if (field === "mcpServers") return f.v.map((x) => '<a class="lnk" href="#/mcp/' + enc(x) + '">' + esc(x) + "</a>" + (h === "codex" && MCPS[x] && MCPS[x].also ? '<span class="sub">runs as ' + esc(x) + "_step, its name clashes with a Codex server</span>" : "")).join(", ") + both;
  if (field === "tools") return esc(f.v.join(", ")) + both;
  return "<code>" + esc(f.v) + "</code>" + both;
}
function agentPage(name, p) {
  const res = resolveAgent(name, ui.from);
  if (!res.winner) return '<div class="page">' + crumbs([["Agents", "#/agents"], [name]]) + '<div class="empty"><h1 class="title">' + esc(name) + '</h1><p>Seen from ' + esc(ui.from) + ", sous finds no copy of " + esc(name) + ". Pick another project in Seen from.</p></div></div>";
  const w = res.winner, def = copyDef(res.def, w), hs = agentHarness(def);
  const dflt = def.codexOnly || (def.harness === "codex" && !def.claudeOnly) ? "codex" : "claude";
  const h = ui.harness[name] && !((ui.harness[name] === "codex" && def.claudeOnly) || (ui.harness[name] === "claude" && def.codexOnly)) ? ui.harness[name] : dflt;
  const path = agentPath(w.folder, name, ui.from), fmt = fmtOf(w.folder), users = agentUsers(name);
  const also = res.hidden.map((x) => '<p class="alsoin">Also in ' + esc(agentPath(x.folder, name, ui.from)) + ", " + esc(x.folder.label) + ". Not used: the copy above comes first.</p>").join("");
  const seen = '<label class="pick narrow-only">Seen from <select data-from aria-label="Seen from">' + PROJECTS.map((x) => '<option value="' + x + '"' + (ui.from === x ? " selected" : "") + ">" + x + "</option>").join("") + "</select></label>";
  const hseg = '<span class="seg" role="group" aria-label="Harness">' + ["claude", "codex"].map((k) => {
    const off = (k === "codex" && def.claudeOnly) || (k === "claude" && def.codexOnly);
    return '<button type="button" data-harness="' + name + "|" + k + '" aria-pressed="' + (h === k) + '"' + (off ? ' disabled aria-disabled="true" data-tip="' + esc(name) + " runs only on " + HNAME[k === "codex" ? "claude" : "codex"] + '"' : "") + ">" + HNAME[k] + (k === dflt && hs === "both" ? '<span class="muted">default</span>' : "") + "</button>";
  }).join("") + "</span>";
  const fields = [["Model", "model"], ["Effort", "effort"], ["Tools", "tools"], ["Skills", "skills"], ["MCP servers", "mcpServers"], ["Permission mode", "permissionMode"], ["Sandbox", "sandbox"]];
  const offNote = hs !== "both" ? '<p class="hint">' + esc(name) + " lives in " + esc(w.folder.dir) + ", so it runs only on " + esc(hs) + ". Move it to .rulesync/subagents to run it on both.</p>" : "";
  const settings = hseg + offNote + '<dl class="kv" style="margin-top:12px">' + fields.map(([l, f]) => "<dt>" + l + "</dt><dd>" + settingVal(def, h, f) + "</dd>").join("") + "</dl>";
  const pkey = "agent:" + name + ":" + ui.from;
  const prompt = mdBlock(pkey, def.body, { path: path.split("/").pop(), rawText: agentFileText(name, def, fmt), mode: fmt === "codex" ? "toml" : "md" });
  const skills = (agentField(def, "claude", "skills") || { v: [] }).v;
  const canCodex = !def.claudeOnly;
  const skRows = skills.map((s) => {
    const k = SKILLS[s], miss = canCodex && k && !k.where.includes("h-codex") ? '<p class="miss">Not in ~/.codex/skills, so Codex steps run without it.</p>' : "";
    return '<div class="lrow">' + ic("skills") + '<div class="grow"><a class="nm lnk" href="#/skills/' + enc(s) + '">' + esc(s) + '</a><p class="d">' + esc(k ? k.description : "") + "</p>" + miss + "</div></div>";
  }).join("");
  const mcps = (agentField(def, def.codexOnly ? "codex" : "claude", "mcpServers") || { v: [] }).v;
  const mcRows = mcps.map((s) => {
    const m = MCPS[s], seenHere = m && (!m.project || m.project === ui.from);
    const note = !m ? '<p class="miss">No server named ' + esc(s) + " in any mcp.jsonc sous reads. sous check reports it.</p>" : !seenHere ? '<p class="miss">Only ' + esc(m.project) + " has it.</p>" : canCodex && m.also ? '<p class="miss">Runs as ' + esc(s) + "_step on Codex.</p>" : "";
    return '<div class="lrow">' + ic("mcp") + '<div class="grow">' + (m ? '<a class="nm lnk" href="#/mcp/' + enc(s) + '">' + esc(s) + "</a>" : "<b>" + esc(s) + "</b>") + '<p class="d">' + esc(m ? mcpLine(m) : "not found") + "</p>" + note + "</div></div>";
  }).join("");
  const lkOpen = ui.lookOpen[name] != null ? ui.lookOpen[name] : res.hidden.length > 0;
  const lookup = '<button class="btn sm" data-lookup="' + esc(name) + '" aria-expanded="' + lkOpen + '" aria-controls="lk-' + esc(name) + '">' + (lkOpen ? "Hide" : "Show") + " the lookup order</button>" +
    (lkOpen ? '<div id="lk-' + esc(name) + '" style="margin-top:8px">' + FOLDERS.map((f) => {
      const pr = res.present.find((x) => x.folder === f), hit = pr.copy && pr === w;
      const fpath = pr.copy ? agentPath(f, name, ui.from) : (f.project ? PROJECT_PATH[ui.from] + "/" : "") + f.dir;
      return '<div class="lk' + (hit ? " hit" : "") + '"><span class="hint">' + f.tier + '</span><span class="fl">' + esc(f.label) + '</span><span class="p">' + pathHtml(fpath) + '</span><span class="s">' + (hit ? "used" : pr.copy ? "hidden" : "none") + "</span></div>";
    }).join("") + '<p class="hint">Project folders first, then home. Inside one tier, the Claude Code copy wins over the Codex one. The first copy found wins.</p></div>' : "");
  return '<div class="page">' + crumbs([["Agents", "#/agents"], ["seen from " + ui.from], [name]]) +
    '<div class="head"><div class="grow"><h1 class="title">' + esc(name) + '</h1><p class="subline">' + esc(def.description) + "</p>" +
    '<p class="pathline">sous uses ' + pathHtml(path, "Copy the path") + " from " + esc(w.folder.label) + "</p>" + also + "</div>" +
    '<div class="actions">' + seen + "</div></div>" +
    pairsHtml([["Runs on", hs === "both" ? "Claude Code and Codex" : esc(hs) + " only", true], ["Default", HNAME[dflt], true], ["Used by", plural(users.length, "step"), true], ["Copies", String(res.hidden.length + 1)]]) +
    sec("ag-set", "Settings", settings) + sec("ag-pr", "Prompt", prompt) +
    sec("ag-sk", "Skills", skRows ? "<div>" + skRows + "</div>" + (canCodex && !def.codexOnly ? '<p class="hint">On Codex it sees every skill in ~/.codex/skills, listed or not.</p>' : "") : '<p class="hint">No skills listed.</p>', '<span class="n">' + skills.length + "</span>") +
    sec("ag-mcp", "MCP servers", mcRows ? "<div>" + mcRows + "</div>" : '<p class="hint">None.</p>', '<span class="n">' + mcps.length + "</span>") +
    sec("ag-lk", "Where sous looks", lookup) +
    sec("ag-used", "Used by", chips(users.map((u) => ["#/workflows/" + enc(u.wf), u.wf + " / " + u.label.replace(/\{(\w+)\}/g, "$1"), ' data-step-link="' + u.id + '"']), "workflows")) + "</div>";
}

/* ------------------------------------------------------------------ skill page */
function skillPage(name) {
  const k = SKILLS[name], key = "skill:" + name, first = SKILL_FOLDERS[k.where[0]];
  const where = Object.keys(SKILL_FOLDERS).map((id) => {
    const f = SKILL_FOLDERS[id], has = k.where.includes(id);
    return '<div class="lrow">' + ic(has ? "ok" : "minus") + '<div class="grow"><b>' + esc(f.label) + '</b><p class="d mono">' + esc(f.dir + name + "/SKILL.md") + "</p>" +
      '<p class="' + (has ? "d" : "miss") + '">' + (has ? esc(f.note) + "." : id === "h-codex" ? "Not here, so no Codex step sees it." : "Not here.") + "</p></div></div>";
  }).join("");
  const listers = Object.keys(AGENT_DEFS).filter((a) => { const r = resolveAgent(a, ui.from); if (!r.winner) return false; const d = copyDef(r.def, r.winner); return !d.codexOnly && (agentField(d, "claude", "skills") || { v: [] }).v.includes(name); });
  const codexAgents = Object.keys(AGENT_DEFS).filter((a) => { const r = resolveAgent(a, ui.from); return r.winner && !copyDef(r.def, r.winner).claudeOnly; });
  const both = listers.filter((a) => !effDef(a, ui.from).claudeOnly);
  const who = '<p class="body">Claude Code agents that list it by name:</p>' + chips(listers.map((a) => ["#/agents/" + enc(a), a]), "agents") +
    (k.where.includes("h-codex") ? '<p class="body">It is in ~/.codex/skills, so all ' + codexAgents.length + " agents that run on Codex see it.</p>" + chips(codexAgents.map((a) => ["#/agents/" + enc(a), a]), "agents")
      : '<div class="note muted-ic">' + ic("info") + '<div class="grow">It is not in ~/.codex/skills, so no Codex step sees it.' + (both.length ? " " + esc(both.join(", ")) + " list it, but run without it on Codex." : "") + "</div></div>");
  return '<div class="page">' + crumbs([["Skills", "#/skills"], [name]]) +
    '<div class="head"><div class="grow"><h1 class="title">' + esc(name) + '</h1><p class="subline">' + esc(k.description) + '</p><p class="pathline">' + pathHtml(first.dir + name + "/SKILL.md", "Copy the path") + "</p></div></div>" +
    sec("sk-md", "SKILL.md", mdBlock(key, k.text, { path: first.dir + name + "/SKILL.md", fm: true })) +
    sec("sk-where", "Where it lives", "<div>" + where + "</div>") + sec("sk-who", "Who sees it", who) + "</div>";
}

/* ------------------------------------------------------------------ MCP page */
function secretVal(v) {
  const m = String(v).match(/\$\{(\w+)\}/);
  if (!m) return "<code>" + esc(v) + '</code><span class="sub">written in the file</span>';
  return '<span class="secret" aria-label="hidden value">' + esc(v.replace(m[0], "••••••••")) + '</span><span class="sub">' + esc(m[1]) + " in ~/.sous/secrets.env</span>";
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
  add("Type", m.type === "stdio" ? "stdio, sous starts it" : "http, sous connects to it");
  if (m.type === "stdio") { add("Command", "<code>" + esc(m.command + " " + m.args.join(" ")) + "</code>"); (m.env || []).forEach(([k, v]) => add("<code>" + esc(k) + "</code>", secretVal(v))); }
  else { add("URL", "<code>" + esc(m.url) + "</code>"); (m.headers || []).forEach(([k, v]) => add("<code>" + esc(k) + "</code>", secretVal(v))); }
  const agents = Object.keys(AGENT_DEFS).filter((a) => { const r = resolveAgent(a, ui.from); if (!r.winner) return false; const d = copyDef(r.def, r.winner); return ((agentField(d, d.codexOnly ? "codex" : "claude", "mcpServers") || { v: [] }).v).includes(name); });
  const steps = [];
  WORKFLOWS.forEach((w) => { if (!w.deleted) walkSaved(w.graph, (x) => { if (x.mcp && x.mcp.includes(name)) steps.push(["#/workflows/" + enc(w.name), w.name + " / " + x.label, ' data-step-link="' + x.id + '"']); }); });
  const seenHere = !m.project || m.project === ui.from;
  return '<div class="page">' + crumbs([["MCP servers", "#/mcp"], ["from " + m.source], [name]]) +
    '<div class="head"><div class="grow"><h1 class="title">' + esc(name) + '</h1><p class="subline">' + esc(mcpLine(m)) + '</p><p class="pathline">' + pathHtml(m.from, "Copy the path") + "</p></div>" +
    '<div class="actions"><label class="pick narrow-only">Seen from <select data-from aria-label="Seen from">' + PROJECTS.map((x) => '<option value="' + x + '"' + (ui.from === x ? " selected" : "") + ">" + x + "</option>").join("") + "</select></label></div></div>" +
    pairsHtml([["Seen by", m.project ? "only " + esc(m.project) : "every project", true], ["Source", esc(m.source), true], ["Secrets", String((m.env || []).concat(m.headers || []).filter(([, v]) => /\$\{/.test(v)).length)]]) +
    (!seenHere ? '<div class="note pause">' + ic("info") + '<div class="grow">Seen from ' + esc(ui.from) + ", this server does not exist. Only " + esc(m.project) + " has it.</div></div>" : "") +
    (m.also ? '<div class="note pause">' + ic("info") + '<div class="grow">' + esc(m.also) + "</div></div>" : "") +
    sec("mcp-con", "Connection", '<dl class="kv">' + rows.join("") + '</dl><p class="hint">sous fills each ${NAME} from ~/.sous/secrets.env when the step starts. Neither this page nor the agent sees the value.</p>') +
    sec("mcp-file", "In the file", codeBlock(mcpJson(name, m), { path: m.from, label: "mcp.jsonc" })) +
    sec("mcp-ag", "Agents that list it", chips(agents.map((a) => ["#/agents/" + enc(a), a]), "agents")) +
    sec("mcp-st", "Steps that add it", chips(steps, "workflows")) + "</div>";
}

/* ------------------------------------------------------------------ settings */
function settingsPage() {
  const keys = [["/", "Search agents, skills and MCP servers"], ["Esc", "Close the top overlay"], ["g r", "Go to runs"], ["g w", "Go to workflows"], ["g a", "Go to agents"], ["g s", "Go to skills"], ["g m", "Go to MCP servers"], ["j k", "Next and previous row in the list"]];
  return '<div class="page">' + crumbs([["Settings"]]) + '<h1 class="title">Settings</h1>' +
    sec("set-th", "Theme", '<div class="seg" role="group" aria-label="Theme">' + [["auto", "Match the system"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => '<button type="button" data-theme-set="' + k + '" aria-pressed="' + (ui.theme === k) + '">' + l + "</button>").join("") + "</div>") +
    sec("set-srv", "sous serve", '<dl class="kv"><dt>Address</dt><dd><code>http://localhost:4317</code></dd><dt>Home</dt><dd><code>~/.sous</code></dd><dt>Projects</dt><dd>' + PROJECTS.map((x) => "<code>" + esc(PROJECT_PATH[x]) + "</code>").join("<br>") + "</dd></dl>") +
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
  if (!t.closest(".pop") && !t.closest("[data-states]") && !t.closest("[data-menu]")) closePops();
  const el = t.closest("[data-x],[data-unremove],[data-undo],[data-copy],[data-copy-start],[data-md],[data-group],[data-clear-filter],[data-col],[data-search],[data-states],[data-theme-toggle],[data-theme-set],[data-reconnect],[data-step],[data-step-go],[data-fold],[data-gfold],[data-zoom],[data-open-step],[data-wf-step],[data-menu],[data-act],[data-more],[data-harness],[data-lookup],[data-step-link],[data-answer-btn],[data-dlg],.search .ri");
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
  if (el.hasAttribute("data-step")) { const id = a("data-step"); setParams({ step: ui.route.params.step === id ? null : id }); refocus('[data-step="' + id + '"]'); return; }
  if (el.hasAttribute("data-step-go")) { setParams({ view: null, step: a("data-step-go") }); const d = $("#drop-" + a("data-step-go")); if (d) d.previousElementSibling.scrollIntoView({ block: "center" }); return; }
  if (el.hasAttribute("data-fold")) { const run = curRun(), n = nodeById(run, a("data-fold")); if (!n) return; ui.fold[run.id + ":" + n.id] = !foldedIn(run, n); refreshSteps(run); refocus('[data-fold="' + n.id + '"]'); return; }
  if (el.hasAttribute("data-gfold")) { const k = a("data-gfold"); ui.gfold[k] = a("aria-expanded") === "true"; route({ keepScroll: true }); refocus('[data-gfold="' + k + '"]'); return; }
  if (el.hasAttribute("data-zoom")) { zoom(el.closest(".gwrap"), a("data-zoom")); return; }
  if (el.hasAttribute("data-open-step")) { setParams({ view: null, step: a("data-open-step") }); const d = $("#drop-" + a("data-open-step")); if (d) { d.previousElementSibling.scrollIntoView({ block: "center" }); refocus('[data-step="' + a("data-open-step") + '"]'); } return; }
  if (el.hasAttribute("data-wf-step")) { const id = a("data-wf-step"), same = ui.route.params.step === id; setParams({ step: same ? null : id }); if (!same) { const i = $("#insp"); if (i) i.scrollIntoView({ block: "nearest" }); } refocus('[data-wf-step="' + id + '"]'); return; }
  if (el.hasAttribute("data-menu")) { const open = !$("#menu").hidden; closePops(); if (!open) openMenu(el); return; }
  if (el.hasAttribute("data-dlg")) { const ok = a("data-dlg") === "ok", f = dlgOk; dlgOk = null; closeDialog(); if (ok && f) f(); return; }
  if (el.hasAttribute("data-act")) { if (el.disabled) return; e.preventDefault(); doAct(a("data-act"), el); return; }
  if (el.hasAttribute("data-more")) { const k = a("data-more"); ui.showAll[k] = true; const run = curRun(); const n = run && run.flat.find((x) => run.id + x.id === k); const box = n && $("#acts-" + n.id); if (box) box.innerHTML = actsHtml(run, n); return; }
  if (el.hasAttribute("data-harness")) { if (el.disabled) return; const [n, h] = a("data-harness").split("|"); ui.harness[n] = h; route({ keepScroll: true }); refocus('[data-harness="' + n + "|" + h + '"]'); return; }
  if (el.hasAttribute("data-lookup")) { const n = a("data-lookup"); const cur = ui.lookOpen[n] != null ? ui.lookOpen[n] : resolveAgent(n, ui.from).hidden.length > 0; ui.lookOpen[n] = !cur; route({ keepScroll: true }); refocus('[data-lookup="' + n + '"]'); return; }
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
  if (open) { const f = $("#col input, #col a"); if (f) f.focus(); } else { const b = $(".col-btn") && getComputedStyle($(".col-btn")).display !== "none" ? $(".col-btn") : $(".rail-menu"); if (b) b.focus(); }
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
    closePops(); hideTip();
  });
  window.addEventListener("hashchange", () => { ui.gone = null; route(); });
  if (!location.hash || location.hash === "#" || location.hash === "#/") { try { history.replaceState(null, "", "#/runs"); } catch (e) { /* file urls */ } }
  route();
  setInterval(tick, 1000);
}
boot();
