// Keeps the view on the DESIGN.md tokens. It fails when a file in src/ holds a raw color, such as
// #fff or rgba(...), outside src/styles/tokens.css, or a Tailwind class the theme cleared, such as
// bg-white, text-gray-500, text-lg or font-bold. Those classes would silently style nothing.
//
//   node scripts/check-tokens.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const ALLOWED = new Set(["src/styles/tokens.css"]);

const RULES = [
  { what: "a raw color", pattern: /#[0-9a-fA-F]{3,8}\b(?![-\w])|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g, only: /\.(css|tsx?)$/ },
  {
    what: "a Tailwind color the theme cleared",
    pattern: /\b(?:bg|text|border|fill|stroke|ring|outline|from|to|via|decoration|divide|placeholder|accent|caret)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/g,
    only: /\.tsx?$/,
  },
  { what: "a weight other than 400 and 500", pattern: /\bfont-(?:thin|extralight|light|semibold|bold|extrabold|black)\b/g, only: /\.tsx?$/ },
  { what: "a text size outside the type scale", pattern: /\btext-(?:base|lg|xl|[2-9]xl)\b/g, only: /\.tsx?$/ },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const found = [];
for (const file of walk(src)) {
  const path = relative(root, file).split("\\").join("/");
  if (ALLOWED.has(path)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const { what, pattern, only } of RULES) {
      if (!only.test(path)) continue;
      for (const m of line.matchAll(pattern)) found.push(`${path}:${i + 1} has ${what}: ${m[0]}`);
    }
  });
}

if (found.length) {
  console.error(`${found.join("\n")}\n\nUse a token from src/styles/tokens.css, or its Tailwind name in src/styles/app.css.`);
  process.exit(1);
}
console.log("check-tokens: every color, weight and text size comes from the tokens.");
