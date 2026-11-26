// Where each part of a graph goes, as the mock's run.js lays it out. Pure: it takes the parts, a
// width and a way to measure text, and gives back boxes, nodes, one SVG path of edges, arrowheads,
// marks and labels. flow-graph.tsx draws what it gives.
//
// A sized part knows its size and the line its edges run on: the y of a left to right graph, or
// the x of the rail of a top to bottom one. Then emit places it and draws its edges. Every edge
// ends in an arrowhead at the step it leads to.
import type { Measure } from "./measure.ts";
import type { Box, Leaf, Part, Seq } from "./tree.ts";
import { foldingBoxes } from "./tree.ts";

const NH = 36;
const GY = 12;
const HDR = 28;
const PAD = 12;
const RAD = 6;
const AH = 6;
const MK = 5;
const GM = 16;
const RG = 40;
const GAPS = [40, 32, 24];

export type Dir = "r" | "l" | "d" | "u";

export interface Placed<P> {
  part: P;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  /** h: one row left to right. w: rows that wrap, as text does. v: top to bottom. */
  mode: "h" | "w" | "v";
  width: number;
  height: number;
  /** Steps and folded boxes. */
  nodes: Placed<Leaf | Box>[];
  /** Open boxes, with the inset of their header, which clears the rail top to bottom. */
  boxes: Array<Placed<Box> & { inset: number }>;
  /** What draws under the edges, outer first: open boxes, and the second border of a pipeline. */
  under: Array<({ t: "box" } & Placed<Box> & { inset: number }) | { t: "plate"; key: string; x: number; y: number; w: number; h: number; open: boolean }>;
  /** Every edge, as one SVG path. */
  edges: string;
  /** Each arrowhead: its tip and the way it points. */
  heads: Array<{ x: number; y: number; dir: Dir }>;
  marks: Array<{ kind: "start" | "end" | "join"; x: number; y: number }>;
  labels: Array<{ x: number; y: number; text: string; align: "c" | "l" | "r" }>;
  /** The boxes drawn folded, by key, the fit's choices and the person's. */
  folded: Record<string, boolean>;
}

/** A part with its size, then its place once emitted. */
interface Sz {
  p: Part;
  w: number;
  h: number;
  /** The width with the labels that run past it. */
  ow: number;
  /** The y of the line left to right, the x of the rail top to bottom. */
  line: number;
  /** Its edge in ends in an arrowhead: it starts with a node. */
  head: boolean;
  /** The width of the node or box itself, without a pipeline's plate. */
  nw: number;
  folded: boolean;
  rx: number;
  ry: number;
  ax: number;
  ay: number;
  kids: Sz[];
  /** A branch's widest lane, and the x of an early return's end mark top to bottom. */
  lw: number;
  xm: number;
}

interface Env {
  m: Measure;
  gap: number;
  /** A node's height: 36, or 40 top to bottom on a narrow screen, for touch. */
  nh: number;
  /** A node's width top to bottom. */
  tbw: number;
  folded: (box: Box) => boolean;
}

interface Out {
  nodes: Layout["nodes"];
  under: Layout["under"];
  paths: string[];
  heads: Layout["heads"];
  marks: Layout["marks"];
  labels: Layout["labels"];
}

const sz = (p: Part, f: Partial<Sz>): Sz => ({ p, w: 0, h: 0, ow: 0, line: 0, head: false, nw: 0, folded: false, rx: 0, ry: 0, ax: 0, ay: 0, kids: [], lw: 0, xm: 0, ...f });
const n1 = (n: number) => String(Math.round(n * 10) / 10);
const nodeLike = (s: Sz) => s.p.t === "leaf" || (s.p.t === "box" && s.folded);
const stackOf = (s: Sz) => ((s.p.t === "leaf" || s.p.t === "box") && s.p.stack ? 4 : 0);
const edgeLabel = (a: Sz | undefined) => (a && a.p.t === "ret" ? a.p.ok : undefined);

/** A node's width follows its text: icon, name, then the agent, the retries, the count and the duration. */
function leafW(e: Env, label: string, sub?: string, retries?: string, count?: string, duration?: string): number {
  let w = 46 + e.m(label, "name");
  for (const s of [sub, retries]) if (s) w += 8 + e.m(s, "label");
  for (const s of [count, duration]) if (s) w += 8 + e.m(s, "mono");
  return Math.max(92, Math.min(280, w));
}

function foldedW(e: Env, b: Box): number {
  return Math.max(leafW(e, b.title, b.foldSub, undefined, b.count, b.duration), 150);
}

// ── Left to right ──

function gapH(e: Env, a: Sz, b: Sz): number {
  if (b.p.t === "ret") return 14;
  if (a.p.t === "start" || b.p.t === "end") return 20;
  const label = edgeLabel(a);
  return Math.max(e.gap, label ? e.m(label, "label") + 28 : 0);
}

function layH(p: Part, e: Env): Sz {
  switch (p.t) {
    case "start":
    case "end":
      return sz(p, { w: 2 * MK, ow: 2 * MK, h: 2 * MK, line: MK, head: p.t === "end" });
    case "leaf": {
      const s = p.stack ? 4 : 0;
      const nw = leafW(e, p.label, p.sub, p.retries, p.count, p.duration);
      return sz(p, { nw, w: nw + s, ow: nw + s, h: NH + s, line: NH / 2, head: true });
    }
    case "seq": {
      const items = p.items.map((it) => layH(it, e));
      // An early return's label may run under the node or end mark after it. Before a box, it keeps its room.
      items.forEach((it, i) => {
        const next = items[i + 1];
        if (it.p.t === "ret") it.w = !next || nodeLike(next) || next.p.t === "end" ? 32 : it.ow;
      });
      const line = items.reduce((m, it) => Math.max(m, it.line), 0);
      let x = 0;
      let h = 0;
      let ow = 0;
      items.forEach((it, i) => {
        if (i) x += gapH(e, items[i - 1], it);
        it.rx = x;
        it.ry = line - it.line;
        x += it.w;
        h = Math.max(h, it.ry + it.h);
        ow = Math.max(ow, it.rx + Math.max(it.ow, it.w));
      });
      return sz(p, { kids: items, w: x, ow: Math.max(x, ow), h, line, head: !!items[0]?.head });
    }
    case "ret": {
      const edge = e.m(p.edge, "label");
      const w = Math.max(32, edge + 30);
      return sz(p, { w, ow: Math.max(w, 18 + edge, 16 + 2 * MK + e.m(p.outcome, "label")), h: 18 + 50 + 2 * MK, line: 18 });
    }
    case "iff": {
      const b = layH(p.body, e);
      b.rx = p.onBack ? 18 : 30;
      b.ry = Math.max(NH / 2 + GY, NH / 2 + GY + NH / 2 - b.line + (p.onBack ? 0 : 6));
      const w = b.rx + b.w + 18;
      return sz(p, { kids: [b], w, ow: w, h: b.ry + b.h, line: NH / 2 });
    }
    case "par": {
      const lanes = p.lanes.map((l) => layH(l, e));
      const condW = p.conds ? Math.max(...p.conds.map((c) => e.m(c, "label"))) : 0;
      const lx = p.conds ? Math.max(26, 24 + condW) : 26;
      let y = 0;
      let lw = 0;
      lanes.forEach((l, i) => {
        l.rx = lx;
        l.ry = y;
        y += l.h + (i < lanes.length - 1 ? GY : 0);
        lw = Math.max(lw, l.w);
      });
      const w = lx + lw + 22;
      return sz(p, { kids: lanes, w, ow: w, lw, xm: lx, h: y, line: lanes[0]?.line ?? 0 });
    }
    case "box": {
      const s = p.stack ? 4 : 0;
      if (e.folded(p)) {
        const nw = foldedW(e, p);
        return sz(p, { folded: true, nw, w: nw + s, ow: nw + s, h: NH + s, line: NH / 2, head: true });
      }
      const b = layH(p.body as Seq, e);
      b.rx = PAD;
      b.ry = HDR;
      const title =
        24 + e.m(p.title, "title") + (p.sub ? 8 + e.m(p.sub, "label") : 0) + (p.count ? 8 + e.m(p.count, "mono") : 0) + (p.foldable ? 36 : 12);
      const nw = Math.max(title, b.w + 2 * PAD, p.again ? e.m(p.again, "label") + 48 : 0);
      return sz(p, { kids: [b], nw, w: nw + s, ow: nw + s, h: HDR + b.h + (p.again ? 44 : PAD) + s, line: HDR + b.line });
    }
  }
}

// ── Top to bottom: one rail on the left, nodes hang from it, branches and detours step to the right ──

function railOf(p: Part, e: Env): number {
  if (p.t === "seq") return p.items.reduce((m, it) => Math.max(m, railOf(it, e)), 0);
  if (p.t === "box" && p.body && !e.folded(p)) return PAD + railOf(p.body, e);
  return 17;
}

function gapV(a: Sz, b: Sz): number {
  if (b.p.t === "ret") return 10;
  if (edgeLabel(a)) return 30;
  return a.p.t === "start" || b.p.t === "end" ? 16 : 22;
}

function layV(p: Part, e: Env, W: number): Sz {
  switch (p.t) {
    case "start":
    case "end":
      return sz(p, { w: 17 + MK, h: 2 * MK, line: 17, head: p.t === "end" });
    case "leaf": {
      const s = p.stack ? 4 : 0;
      const nw = Math.min(W, e.tbw) - s;
      return sz(p, { nw, w: nw + s, h: e.nh + s, line: 17, head: true });
    }
    case "seq": {
      const R = railOf(p, e);
      let y = 0;
      let w = 0;
      const items: Sz[] = [];
      p.items.forEach((part, i) => {
        const shift = R - railOf(part, e);
        const it = layV(part, e, W - shift);
        if (i) y += gapV(items[i - 1], it);
        it.rx = shift;
        it.ry = y;
        y += it.h;
        w = Math.max(w, shift + it.w);
        items.push(it);
      });
      return sz(p, { kids: items, w, h: y, line: R, head: !!items[0]?.head });
    }
    case "ret": {
      const xm = 17 + 14 + e.m(p.edge, "label") + 8;
      return sz(p, { xm, w: Math.min(W, xm + 2 * MK + 8 + e.m(p.outcome, "label")), h: 30, line: 17 });
    }
    case "iff": {
      const bx = 31;
      const b = layV(p.body, e, W - bx);
      b.rx = bx;
      b.ry = p.onBack ? 10 : 24;
      return sz(p, { kids: [b], w: bx + b.w, h: b.ry + b.h + 18, line: 17 });
    }
    case "par": {
      const condW = p.conds ? Math.max(...p.conds.map((c) => e.m(c, "label"))) : 0;
      const lx = p.conds ? Math.max(33, 32 + condW) : 33;
      let y = 4;
      let lw = 0;
      const lanes = p.lanes.map((lane, i) => {
        const l = layV(lane, e, W - lx - 18);
        l.rx = lx;
        l.ry = y;
        y += l.h + (i < p.lanes.length - 1 ? GY : 0);
        lw = Math.max(lw, l.w);
        return l;
      });
      return sz(p, { kids: lanes, lw, xm: lx, w: lx + lw + 18, h: y + 16, line: 17 });
    }
    case "box": {
      const s = p.stack ? 4 : 0;
      if (e.folded(p)) {
        const nw = Math.min(W, e.tbw) - s;
        return sz(p, { folded: true, nw, w: nw + s, h: e.nh + s, line: 17, head: true });
      }
      const back = p.again ? 26 : 0;
      const b = layV(p.body as Seq, e, Math.min(W, e.tbw + 2 * PAD + back) - 2 * PAD - back - s);
      b.rx = PAD;
      b.ry = HDR;
      const nw = Math.max(b.w + 2 * PAD + back, p.again ? e.m(p.again, "label") + 2 * PAD + back : 0);
      return sz(p, { kids: [b], nw, w: nw + s, h: HDR + b.h + (p.again ? 30 : PAD) + s, line: PAD + b.line });
    }
  }
}

// ── Drawing ──

function arrow(o: Out, x: number, y: number, dir: Dir) {
  o.heads.push({ x, y, dir });
}

function caption(o: Out, x: number, y: number, text: string | undefined, align: "c" | "l" | "r" = "c") {
  if (text) o.labels.push({ x, y, text, align });
}

/** The first and the last node of a part, for a loop's back arrow. */
function firstNode(s: Sz): Sz | null {
  if (nodeLike(s) || s.p.t === "box") return s;
  if (s.p.t === "seq") {
    for (const it of s.kids) {
      const f = firstNode(it);
      if (f) return f;
    }
    return null;
  }
  if (s.p.t === "iff" || s.p.t === "par") return s.kids[0] ? firstNode(s.kids[0]) : null;
  return null;
}

function lastNode(s: Sz): Sz | null {
  if (nodeLike(s) || s.p.t === "box") return s;
  if (s.p.t === "seq") {
    for (let i = s.kids.length - 1; i >= 0; i--) {
      const f = s.kids[i].p.t === "iff" ? null : lastNode(s.kids[i]);
      if (f) return f;
    }
    return null;
  }
  if (s.p.t === "par") return s.kids.length ? lastNode(s.kids[s.kids.length - 1]) : null;
  return null;
}

/** A node or a folded box, with the plate behind a pipeline. */
function emitNode(s: Sz, x: number, y: number, h: number, o: Out) {
  if (stackOf(s)) o.under.push({ t: "plate", key: s.p.key, x: x + 4, y: y + 4, w: s.nw, h, open: false });
  o.nodes.push({ part: s.p as Leaf | Box, x, y, w: s.nw, h });
}

function emitBox(s: Sz, x: number, y: number, inset: number, o: Out) {
  const h = s.h - stackOf(s);
  if (stackOf(s)) o.under.push({ t: "plate", key: s.p.key, x: x + 4, y: y + 4, w: s.nw, h, open: true });
  o.under.push({ t: "box", part: s.p as Box, x, y, w: s.nw, h, inset });
}

function emitH(s: Sz, x: number, y: number, o: Out) {
  s.ax = x;
  s.ay = y;
  const py = y + s.line;
  const P = o.paths;
  switch (s.p.t) {
    case "start":
    case "end":
      o.marks.push({ kind: s.p.t, x: x + MK, y: py });
      return;
    case "leaf":
      emitNode(s, x, y, NH, o);
      return;
    case "seq":
      s.kids.forEach((it, i) => {
        emitH(it, x + it.rx, y + it.ry, o);
        if (!i) return;
        const a = s.kids[i - 1];
        const x1 = a.ax + (a.nw || a.w);
        const x2 = it.ax;
        P.push(`M${n1(x1)} ${n1(py)}H${n1(it.head ? x2 - 3 : x2)}`);
        if (it.head) arrow(o, x2, py, "r");
        caption(o, (x1 + x2) / 2, py - 10, edgeLabel(a));
      });
      return;
    case "ret": {
      const sx = x + 10;
      const ye = py + 50;
      P.push(`M${n1(x)} ${n1(py)}H${n1(x + s.w)}`, `M${n1(sx)} ${n1(py)}V${n1(ye - 3)}`);
      arrow(o, sx, ye, "d");
      o.marks.push({ kind: "join", x: sx, y: py }, { kind: "end", x: sx, y: ye + MK });
      caption(o, sx + 8, py + 30, s.p.edge, "l");
      caption(o, sx + MK + 7, ye + MK, s.p.outcome, "l");
      return;
    }
    case "iff": {
      const b = s.kids[0];
      emitH(b, x + b.rx, y + b.ry, o);
      const by = y + b.ry + b.line;
      const bx = x + b.rx;
      const be = bx + b.w;
      const xf = x + 8;
      const xj = x + s.w - 8;
      P.push(`M${n1(x)} ${n1(py)}H${n1(x + s.w)}`);
      if (!s.p.onBack) {
        P.push(`M${n1(xf)} ${n1(py)}V${n1(by - RAD)}Q${n1(xf)} ${n1(by)} ${n1(xf + RAD)} ${n1(by)}H${n1(b.head ? bx - 3 : bx)}`);
        if (b.head) arrow(o, bx, by, "r");
        o.marks.push({ kind: "join", x: xf, y: py });
        caption(o, bx + 4, py + 13, s.p.label, "l");
      }
      if (!s.p.ends) {
        P.push(`M${n1(be)} ${n1(by)}H${n1(xj - RAD)}Q${n1(xj)} ${n1(by)} ${n1(xj)} ${n1(by - RAD)}V${n1(py)}`);
        o.marks.push({ kind: "join", x: xj, y: py });
      }
      return;
    }
    case "par": {
      const xm = x + 8;
      const xj = x + s.xm + s.lw + 12;
      const conds = s.p.conds;
      s.kids.forEach((l, i) => {
        emitH(l, x + l.rx, y + l.ry, o);
        const ly = y + l.ry + l.line;
        const lx = x + l.rx;
        const le = lx + l.w;
        const into = l.head ? lx - 3 : lx;
        if (!i) P.push(`M${n1(x)} ${n1(py)}H${n1(into)}`, `M${n1(le)} ${n1(py)}H${n1(x + s.w)}`);
        else
          P.push(
            `M${n1(xm)} ${n1(py)}V${n1(ly - RAD)}Q${n1(xm)} ${n1(ly)} ${n1(xm + RAD)} ${n1(ly)}H${n1(into)}`,
            `M${n1(le)} ${n1(ly)}H${n1(xj - RAD)}Q${n1(xj)} ${n1(ly)} ${n1(xj)} ${n1(ly - RAD)}V${n1(py)}`,
          );
        if (l.head) arrow(o, lx, ly, "r");
        if (conds) caption(o, x + 16, ly - 10, conds[i], "l");
      });
      if (s.kids.length > 1) o.marks.push({ kind: "join", x: xm, y: py }, { kind: "join", x: xj, y: py });
      return;
    }
    case "box": {
      if (s.folded) {
        emitNode(s, x, y, NH, o);
        return;
      }
      emitBox(s, x, y, 10, o);
      const b = s.kids[0];
      emitH(b, x + b.rx, y + b.ry, o);
      P.push(`M${n1(x)} ${n1(py)}H${n1(b.head ? x + PAD - 3 : x + PAD)}`, `M${n1(x + PAD + b.w)} ${n1(py)}H${n1(x + s.nw)}`);
      if (b.head) arrow(o, x + PAD, py, "r");
      if (s.p.again) backH(s, o);
      return;
    }
  }
}

/** A loop's back arrow: from under its last step, along the bottom of the box, up into its first step. */
function backH(s: Sz, o: Out) {
  const body = s.kids[0];
  const F = firstNode(body);
  const L = lastNode(body);
  if (!F || !L) return;
  const bot = (n: Sz) => n.ay + (nodeLike(n) ? NH : n.h - stackOf(n));
  const yb = s.ay + HDR + body.h + 16;
  const fb = bot(F);
  const lb = bot(L);
  let x1 = L.ax + L.nw / 2;
  let x2 = F.ax + F.nw / 2;
  if (F === L) {
    x1 = L.ax + L.nw * 0.62;
    x2 = L.ax + L.nw * 0.38;
  }
  o.paths.push(
    `M${n1(x1)} ${n1(lb)}V${n1(yb - RAD)}Q${n1(x1)} ${n1(yb)} ${n1(x1 - RAD)} ${n1(yb)}H${n1(x2 + RAD)}Q${n1(x2)} ${n1(yb)} ${n1(x2)} ${n1(yb - RAD)}V${n1(fb + 3)}`,
  );
  arrow(o, x2, fb, "u");
  caption(o, (x1 + x2) / 2, yb + 12, (s.p as Box).again);
}

function emitV(s: Sz, x: number, y: number, e: Env, o: Out) {
  s.ax = x;
  s.ay = y;
  const rx = x + s.line;
  const P = o.paths;
  switch (s.p.t) {
    case "start":
    case "end":
      o.marks.push({ kind: s.p.t, x: rx, y: y + MK });
      return;
    case "leaf":
      emitNode(s, x, y, e.nh, o);
      return;
    case "seq":
      s.kids.forEach((it, i) => {
        emitV(it, x + it.rx, y + it.ry, e, o);
        if (!i) return;
        const a = s.kids[i - 1];
        const y1 = a.ay + a.h - stackOf(a);
        const y2 = it.ay;
        P.push(`M${n1(rx)} ${n1(y1)}V${n1(it.head ? y2 - 3 : y2)}`);
        if (it.head) arrow(o, rx, y2, "d");
        caption(o, rx + 9, (y1 + y2) / 2, edgeLabel(a), "l");
      });
      return;
    case "ret": {
      const sy = y + 18;
      const xm = x + s.xm;
      P.push(`M${n1(rx)} ${n1(y)}V${n1(y + s.h)}`, `M${n1(rx)} ${n1(sy)}H${n1(xm - 3)}`);
      arrow(o, xm, sy, "r");
      o.marks.push({ kind: "join", x: rx, y: sy }, { kind: "end", x: xm + MK, y: sy });
      caption(o, rx + 12, sy - 9, s.p.edge, "l");
      caption(o, xm + 2 * MK + 6, sy, s.p.outcome, "l");
      return;
    }
    case "iff": {
      const b = s.kids[0];
      emitV(b, x + b.rx, y + b.ry, e, o);
      const bx = x + b.rx + b.line;
      const bt = y + b.ry;
      const bb = bt + b.h;
      const yj = bb + 12;
      P.push(`M${n1(rx)} ${n1(y)}V${n1(y + s.h)}`);
      if (!s.p.onBack) {
        P.push(`M${n1(rx)} ${n1(y + 6)}H${n1(bx - RAD)}Q${n1(bx)} ${n1(y + 6)} ${n1(bx)} ${n1(y + 6 + RAD)}V${n1(b.head ? bt - 3 : bt)}`);
        if (b.head) arrow(o, bx, bt, "d");
        caption(o, bx + 9, y + 15, s.p.label, "l");
      }
      if (!s.p.ends) {
        P.push(`M${n1(bx)} ${n1(bb)}V${n1(yj - RAD)}Q${n1(bx)} ${n1(yj)} ${n1(bx - RAD)} ${n1(yj)}H${n1(rx)}`);
        o.marks.push({ kind: "join", x: rx, y: yj });
      }
      return;
    }
    case "par": {
      const xj = x + s.xm + s.lw + 10;
      const yb = y + s.h - 6;
      const conds = s.p.conds;
      let lastIn = y;
      s.kids.forEach((l, i) => {
        emitV(l, x + l.rx, y + l.ry, e, o);
        const f = firstNode(l);
        const z = lastNode(l);
        const fy = f ? f.ay + e.nh / 2 : y + l.ry;
        const ey = z ? z.ay + e.nh / 2 : y + l.ry;
        const fx = f ? f.ax : x + l.rx;
        const ex = z ? z.ax + z.nw : x + l.rx;
        P.push(`M${n1(rx)} ${n1(fy - RAD)}Q${n1(rx)} ${n1(fy)} ${n1(rx + RAD)} ${n1(fy)}H${n1(fx - 3)}`);
        arrow(o, fx, fy, "r");
        P.push(`M${n1(ex)} ${n1(ey)}H${n1(xj - RAD)}Q${n1(xj)} ${n1(ey)} ${n1(xj)} ${n1(ey + RAD)}V${n1(yb)}`);
        if (conds) caption(o, rx + RAD + 3, fy - 9, conds[i], "l");
        lastIn = Math.max(lastIn, fy - RAD);
      });
      P.push(
        `M${n1(rx)} ${n1(y)}V${n1(lastIn)}`,
        `M${n1(xj)} ${n1(yb - RAD)}Q${n1(xj)} ${n1(yb)} ${n1(xj - RAD)} ${n1(yb)}H${n1(rx + RAD)}Q${n1(rx)} ${n1(yb)} ${n1(rx)} ${n1(yb + RAD)}V${n1(y + s.h)}`,
      );
      if (s.kids.length > 1) o.marks.push({ kind: "join", x: rx, y });
      return;
    }
    case "box": {
      if (s.folded) {
        emitNode(s, x, y, e.nh, o);
        return;
      }
      emitBox(s, x, y, s.line + 10, o);
      const b = s.kids[0];
      emitV(b, x + b.rx, y + b.ry, e, o);
      const bt = y + b.ry;
      const bb = bt + b.h;
      P.push(`M${n1(rx)} ${n1(y)}V${n1(b.head ? bt - 3 : bt)}`, `M${n1(rx)} ${n1(bb)}V${n1(y + s.h - stackOf(s))}`);
      if (b.head) arrow(o, rx, bt, "d");
      if (s.p.again) backV(s, e, o);
      return;
    }
  }
}

/** Top to bottom, the back arrow runs up the right side of the box, from its last step into its first. */
function backV(s: Sz, e: Env, o: Out) {
  const body = s.kids[0];
  const F = firstNode(body);
  const L = lastNode(body);
  if (!F || !L) return;
  const xr = s.ax + s.nw - PAD - 6;
  const fy = F.ay + e.nh / 2;
  const ly = L.ay + e.nh / 2;
  const fx = F.ax + F.nw;
  const lx = L.ax + L.nw;
  if (F === L) {
    const yb = L.ay + e.nh + 10;
    const xc = L.ax + L.nw * 0.5;
    o.paths.push(
      `M${n1(lx)} ${n1(ly)}H${n1(xr - RAD)}Q${n1(xr)} ${n1(ly)} ${n1(xr)} ${n1(ly + RAD)}V${n1(yb - RAD)}Q${n1(xr)} ${n1(yb)} ${n1(xr - RAD)} ${n1(yb)}H${n1(xc + RAD)}Q${n1(xc)} ${n1(yb)} ${n1(xc)} ${n1(yb - RAD)}V${n1(L.ay + e.nh + 3)}`,
    );
    arrow(o, xc, L.ay + e.nh, "u");
  } else {
    o.paths.push(
      `M${n1(lx)} ${n1(ly)}H${n1(xr - RAD)}Q${n1(xr)} ${n1(ly)} ${n1(xr)} ${n1(ly - RAD)}V${n1(fy + RAD)}Q${n1(xr)} ${n1(fy)} ${n1(xr - RAD)} ${n1(fy)}H${n1(fx + 3)}`,
    );
    arrow(o, fx, fy, "l");
  }
  caption(o, xr + 4, s.ay + HDR + body.h + 14, (s.p as Box).again, "r");
}

/** From the end of one row, round the right side, back under the row, and into the start of the next. */
function rowReturn(o: Out, xr: number, y1: number, y2: number, ym: number, head: boolean) {
  const xe = xr + 10;
  const xl = GM - 8;
  o.paths.push(
    `M${n1(xr)} ${n1(y1)}H${n1(xe - RAD)}Q${n1(xe)} ${n1(y1)} ${n1(xe)} ${n1(y1 + RAD)}V${n1(ym - RAD)}Q${n1(xe)} ${n1(ym)} ${n1(xe - RAD)} ${n1(ym)}` +
      `H${n1(xl + RAD)}Q${n1(xl)} ${n1(ym)} ${n1(xl)} ${n1(ym + RAD)}V${n1(y2 - RAD)}Q${n1(xl)} ${n1(y2)} ${n1(xl + RAD)} ${n1(y2)}H${n1(head ? GM - 3 : GM)}`,
  );
  if (head) arrow(o, GM, y2, "r");
}

// ── The fit ──

/**
 * The top-level columns in rows of the box's width. The start mark and an early return keep to the
 * step after them, an early return and the end mark to the step before. Null when a column is wider
 * than the box, or when a row but the last is under half the box.
 */
function wrapRows(top: Seq, e: Env, cw: number): Part[][] | null {
  const avail = cw - 2 * GM - 16;
  const items = top.items.map((it) => layH(it, e));
  const units: Sz[][] = [];
  items.forEach((it, i) => {
    const prev = items[i - 1];
    if (units.length && (it.p.t === "ret" || it.p.t === "end" || prev.p.t === "start" || prev.p.t === "ret")) units[units.length - 1].push(it);
    else units.push([it]);
  });
  const unitW = (u: Sz[]) => u.reduce((a, it, i) => a + (i ? gapH(e, u[i - 1], it) : 0) + (i === u.length - 1 ? Math.max(it.ow, it.w) : it.w), 0);
  const rows: Sz[][] = [];
  let cur: Sz[] | null = null;
  let w = 0;
  for (const u of units) {
    const v = unitW(u);
    if (v > avail) return null;
    const gap = cur ? gapH(e, cur[cur.length - 1], u[0]) : 0;
    if (cur && w + gap + v <= avail) {
      cur.push(...u);
      w += gap + v;
    } else {
      cur = u.slice();
      rows.push(cur);
      w = v;
    }
  }
  const rowW = rows.map((r) => r.reduce((a, it, i) => a + (i ? gapH(e, r[i - 1], it) : 0) + it.w, 0));
  if (rows.length < 2 || rowW.slice(0, -1).some((x) => x < avail / 2)) return null;
  return rows.map((r) => r.map((it) => it.p));
}

function draw(top: Seq, e: Env, mode: Layout["mode"], rows: Part[][] | null): Omit<Layout, "folded"> {
  const o: Out = { nodes: [], under: [], paths: [], heads: [], marks: [], labels: [] };
  let width: number;
  let height: number;
  if (mode === "v") {
    const s = layV(top, e, e.tbw);
    emitV(s, GM, GM, e, o);
    width = s.w + 2 * GM;
    height = s.h + 2 * GM;
  } else if (mode === "w" && rows) {
    let y = GM;
    let prev: Sz | null = null;
    let py = 0;
    width = 0;
    rows.forEach((items, i) => {
      const row = layH({ t: "seq", key: `${top.key}/row${i}`, items }, e);
      emitH(row, GM, y, o);
      if (prev) rowReturn(o, GM + prev.w, py + prev.line, y + row.line, py + prev.h + RG / 2, row.head);
      width = Math.max(width, row.ow);
      prev = row;
      py = y;
      y += row.h + RG;
    });
    width += 2 * GM + 12;
    height = y - RG + GM;
  } else {
    const s = layH(top, e);
    emitH(s, GM, GM, o);
    width = s.ow + 2 * GM;
    height = s.h + 2 * GM;
  }
  const { paths, ...rest } = o;
  const boxes = o.under.flatMap((u) => (u.t === "box" ? [u] : []));
  return { mode, width, height, edges: paths.join(""), boxes, ...rest };
}

export interface LayoutOptions {
  /** The width of the canvas's box. */
  width: number;
  /** Under 700px: always top to bottom, with 40px nodes. */
  narrow: boolean;
  measure: Measure;
  /** The boxes the person folded (true) or opened (false), by key. */
  folds: Record<string, boolean>;
}

/**
 * Lays out a graph to fit its box, in this order, each with a gap of 40, 32 or 24px: one row of
 * columns; one row with the boxes nested in other boxes folded; rows of columns; rows with the
 * nested boxes folded. Then top to bottom, with the nested boxes folded. A fold chosen by hand
 * stays. So every node shows at 100%.
 */
export function layoutGraph(top: Seq, opts: LayoutOptions): Layout {
  const cw = opts.width;
  const boxes = foldingBoxes(top);
  const autos = boxes.filter(({ box }) => box.auto && !(box.key in opts.folds));
  const nested = autos.filter((a) => a.depth > 0).map((a) => a.box);
  let fit = new Set<Box>();
  const folded = (b: Box) => !b.body || (opts.folds[b.key] ?? (fit.has(b) || (!b.auto && !!b.folded)));
  const env = (gap: number, nh: number): Env => ({ m: opts.measure, gap, nh, tbw: Math.max(160, Math.min(420, cw - 2 * GM - 2)), folded });
  let chosen: Omit<Layout, "folded"> | null = null;
  if (!opts.narrow) {
    const tries: Array<["h" | "w", Box[]]> = [
      ["h", []],
      ["h", nested],
      ["w", []],
      ["w", nested],
    ];
    for (const [mode, list] of tries.filter(([, l], i) => i % 2 === 0 || l.length)) {
      fit = new Set(list);
      if (mode === "h") {
        const gap = GAPS.find((g) => layH(top, env(g, NH)).ow + 2 * GM <= cw);
        if (gap) chosen = draw(top, env(gap, NH), "h", null);
      } else {
        const best = GAPS.map((g) => ({ g, rows: wrapRows(top, env(g, NH), cw) }))
          .filter((r): r is { g: number; rows: Part[][] } => !!r.rows)
          .sort((a, b) => a.rows.length - b.rows.length)[0];
        if (best) chosen = draw(top, env(best.g, NH), "w", best.rows);
      }
      if (chosen) break;
    }
  }
  if (!chosen) {
    fit = new Set(nested);
    chosen = draw(top, env(40, opts.narrow ? 40 : NH), "v", null);
  }
  const out: Record<string, boolean> = {};
  for (const { box } of boxes) out[box.key] = folded(box);
  return { ...chosen, folded: out };
}
