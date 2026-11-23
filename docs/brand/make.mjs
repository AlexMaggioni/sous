// Writes the sous brand SVGs into this folder: node docs/brand/make.mjs
//
// The mark is one strip of order ticket, folded four times at 45 degrees into an S. The bars show
// the front of the paper and the uprights its back. The strip starts as a short tab under the top
// bar and ends torn, bottom left. The wordmark draws lowercase "sous" on the same rules.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));

const COPPER = "#B5602A", COPPER_DEEP = "#7A3A16";
const COPPER_D = "#DB8550", COPPER_DEEP_D = "#9C4F25";
const INK = "#1D1A16", CREAM_TEXT = "#F2EBDD";

const n = (v) => String(Math.round(v * 100) / 100);
const poly = (pts, dx = 0, dy = 0) => "M" + pts.map(([x, y]) => `${n(x + dx)} ${n(y + dy)}`).join(" L") + " Z";
const path = (d, fill) => `<path fill="${fill}" d="${d}"/>`;
const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}"><title>sous</title>${body}</svg>\n`;
const save = (name, text) => writeFileSync(join(OUT, name), text);

// The mark, on a 256 canvas. The strip is W wide and spans x L..R, y T..B+W.
const W = 40, L = 40, R = 216, T = 24, M = 104, B = 192, TAB = 24;

/** The mark's pieces. g > 0 cuts a gap at each fold, for the one-colour mark. */
function ribbonParts(g = 0, teeth = 10, amp = 5) {
  const torn = Array.from({ length: teeth + 1 }, (_, i) => [L + (i * W) / teeth, B - TAB - (i % 2 ? amp : 0)]);
  const back = [
    [[R - W, T + W + g], [R, T + W + g], [R, T + W + TAB], [R - W, T + W + TAB]], // start tab
    [[L + W, T], [L + W, M - g], [L, M - g], [L, T + W]], // left upright
    [[R - W, M], [R, M + W], [R, B - g], [R - W, B - g]], // right upright
    [[L + W, B + W], [L, B], ...torn], // torn end
  ];
  const front = [
    [[L + W + g, T], [R - W, T], [R, T + W], [L + W + g, T + W]], // top bar
    [[L, M], [R - W - g, M], [R - W - g, M + W], [L + W, M + W]], // mid bar
    [[R - W, B], [R, B], [R - W, B + W], [L + W + g, B + W], [L + W + g, B]], // bottom bar
  ];
  return { front, back };
}

function ribbon(frontFill, backFill, g = 0) {
  const { front, back } = ribbonParts(g);
  return path(back.map((p) => poly(p)).join(" "), backFill) + path(front.map((p) => poly(p)).join(" "), frontFill);
}

// The small cut, on a 16 grid: bars 3 px tall at y 2, 7 and 12, uprights 3 px wide at x 2 and 11.
const SMALL = {
  back: [
    [[11, 5], [14, 5], [14, 6], [11, 6]],
    [[5, 2], [5, 7], [2, 7], [2, 5]],
    [[11, 7], [14, 10], [14, 12], [11, 12]],
    [[5, 15], [2, 12], [2, 11], [5, 11]],
  ],
  front: [
    [[5, 2], [11, 2], [14, 5], [5, 5]],
    [[2, 7], [11, 7], [11, 10], [5, 10]],
    [[11, 12], [14, 12], [11, 15], [5, 15], [5, 12]],
  ],
};
const smallBack = SMALL.back.map((p) => poly(p)).join(" ");
const smallFront = SMALL.front.map((p) => poly(p)).join(" ");

// The wordmark: straight strokes, outer corners cut at 45 degrees, inner corners cut so the
// stroke keeps its width on the diagonal.
const XH = 100, S = 21, CI = S * (Math.SQRT2 - 1), GAP = 13;

function letterS(x0, w = 78) {
  const h = XH, s = S, m0 = (XH - S) / 2, m1 = m0 + s;
  const pts = [[s, 0], [w - s, 0], [w, s], [s, s], [s, m0], [w - s, m0], [w, m0 + s], [w, h - s], [w - s, h],
    [s, h], [0, h - s], [w - s, h - s], [w - s, m1], [s, m1], [0, m1 - s], [0, s]];
  return { d: poly(pts, x0), w };
}

function letterO(x0, w = 84) {
  const h = XH, s = S, c = CI;
  const outer = [[s, 0], [w - s, 0], [w, s], [w, h - s], [w - s, h], [s, h], [0, h - s], [0, s]];
  const inner = [[s + c, s], [s, s + c], [s, h - s - c], [s + c, h - s], [w - s - c, h - s], [w - s, h - s - c],
    [w - s, s + c], [w - s - c, s]];
  return { d: poly(outer, x0) + " " + poly(inner, x0), w };
}

function letterU(x0, w = 84) {
  const h = XH, s = S, c = CI;
  const pts = [[0, 0], [s, 0], [s, h - s - c], [s + c, h - s], [w - s, h - s], [w - s, 0], [w, 0], [w, h], [s, h], [0, h - s]];
  return { d: poly(pts, x0), w };
}

function wordmark(fill, dx, dy) {
  const parts = [];
  let x = 0;
  for (const make of [letterS, letterO, letterU, letterS]) {
    const { d, w } = make(x);
    parts.push(d);
    x += w + GAP;
  }
  return { body: `<g transform="translate(${n(dx)} ${n(dy)})">${path(parts.join(" "), fill)}</g>`, width: x - GAP };
}

// The marks.
save("mark.svg", svg(256, 256, ribbon(COPPER, COPPER_DEEP)));
save("mark-dark.svg", svg(256, 256, ribbon(COPPER_D, COPPER_DEEP_D)));
save("mark-mono-black.svg", svg(256, 256, ribbon("#000", "#000", 7)));
save("mark-mono-white.svg", svg(256, 256, ribbon("#FFF", "#FFF", 7)));
save("mark-small.svg", svg(16, 16, path(smallBack, COPPER_DEEP) + path(smallFront, COPPER)));

// The favicon: the small cut, in the dark colours when the browser is dark.
const favStyle = `<style>.f{fill:${COPPER}}.b{fill:${COPPER_DEEP}}@media (prefers-color-scheme: dark){.f{fill:${COPPER_D}}.b{fill:${COPPER_DEEP_D}}}</style>`;
save("favicon.svg", svg(16, 16, `${favStyle}<path class="b" d="${smallBack}"/><path class="f" d="${smallFront}"/>`));

// The app icon: the dark mark at 68 percent, centred on an ink tile.
const k = 0.68;
save("app-icon.svg", svg(256, 256,
  `<rect width="256" height="256" rx="56" fill="${INK}"/>` +
  `<g transform="translate(${n(128 - 128 * k)} ${n(128 - 128 * k)}) scale(${n(k)})">${ribbon(COPPER_D, COPPER_DEEP_D)}</g>`));

// The lockups: the mark at 80 percent, then the wordmark, centred on the mark's height.
const MK = 0.8, PAD = 8, GAP_MARK = 44;
const markW = (R - L) * MK, markH = (B + W - T) * MK;
function lockup(front, back, ink) {
  const mark = `<g transform="translate(${n(PAD - L * MK)} ${n(PAD - T * MK)}) scale(${n(MK)})">${ribbon(front, back)}</g>`;
  const word = wordmark(ink, PAD + markW + GAP_MARK, PAD + (markH - XH) / 2 + 8);
  return svg(PAD + markW + GAP_MARK + word.width + PAD, PAD * 2 + markH, mark + word.body);
}
save("lockup-light.svg", lockup(COPPER, COPPER_DEEP, INK));
save("lockup-dark.svg", lockup(COPPER_D, COPPER_DEEP_D, CREAM_TEXT));

const word = wordmark(INK, 4, 4);
save("wordmark.svg", svg(word.width + 8, XH + 8, word.body));
