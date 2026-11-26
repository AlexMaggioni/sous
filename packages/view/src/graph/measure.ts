// Text widths for the layout. In the browser they come from a canvas in the page's own fonts.
// Without one, such as in tests, an estimate from the letters stands in.

/** name: a node's 13px name. label: 12px text on an edge or after a name. title: a box's 500 12px title. mono: 12px numbers. */
export type Font = "name" | "label" | "title" | "mono";

export type Measure = (text: string, font: Font) => number;

const SIZE: Record<Font, number> = { name: 13, label: 12, title: 12, mono: 12 };

/** A width from the letters alone, about what IBM Plex Sans and Mono give. */
function estimate(text: string, font: Font): number {
  const px = SIZE[font];
  if (font === "mono") return Math.ceil(text.length * px * 0.6);
  let em = 0;
  for (const c of text) {
    if ("ijl.,:;'|!()[]".includes(c)) em += 0.3;
    else if ("mwMW".includes(c)) em += 0.85;
    else if (c === " ") em += 0.28;
    else if (c >= "A" && c <= "Z") em += 0.66;
    else em += 0.55;
  }
  return Math.ceil(em * px * (font === "title" ? 1.03 : 1));
}

/**
 * A measure in the page's fonts, with its own cache. Make a new one once the web fonts load,
 * since the widths change then.
 */
export function pageMeasure(): Measure {
  const cache = new Map<string, number>();
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let fonts: Record<Font, string> | null = null;
  if (typeof OffscreenCanvas !== "undefined" && typeof document !== "undefined" && document.body) {
    ctx = new OffscreenCanvas(1, 1).getContext("2d");
    const style = getComputedStyle(document.body);
    const sans = style.fontFamily || "sans-serif";
    const mono = style.getPropertyValue("--mono").trim() || "monospace";
    fonts = { name: `13px ${sans}`, label: `12px ${sans}`, title: `500 12px ${sans}`, mono: `12px ${mono}` };
  }
  return (text, font) => {
    const id = `${font}\n${text}`;
    let width = cache.get(id);
    if (width === undefined) {
      if (ctx && fonts) {
        ctx.font = fonts[font];
        width = Math.ceil(ctx.measureText(text).width);
      } else width = estimate(text, font);
      cache.set(id, width);
    }
    return width;
  };
}
