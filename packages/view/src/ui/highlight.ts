// Syntax colors for code, from shiki loaded on first use, in the grays of DESIGN.md. Code shows as plain text until then.
import { useEffect, useState } from "react";
import type { HighlighterCore } from "shiki/core";

const LANGS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

export type Lang = keyof typeof LANGS;

const ALIAS: Record<string, Lang> = {
  ts: "typescript", mts: "typescript", cts: "typescript", typescript: "typescript",
  tsx: "tsx", jsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", javascript: "javascript",
  json: "json", jsonc: "json", jsonl: "json",
  yaml: "yaml", yml: "yaml", toml: "toml",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript", shellscript: "shellscript",
  md: "markdown", markdown: "markdown",
  diff: "diff", patch: "diff",
};

/** The language of a fence name such as "ts", or of a path such as "fix-tests.js". Others stay plain. */
export function langOf(name: string | undefined): Lang | undefined {
  if (!name) return undefined;
  const key = name.toLowerCase();
  return ALIAS[key] ?? ALIAS[key.split(".").pop() ?? ""];
}

/** One piece of a line. `color` is a CSS variable from the theme, set in parts.css. */
export type Token = { text: string; color?: string; italic: boolean; strong: boolean };

let loading: Promise<HighlighterCore> | undefined;

function highlighter(): Promise<HighlighterCore> {
  loading ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(([shiki, engine]) =>
    shiki.createHighlighterCore({
      themes: [shiki.createCssVariablesTheme({ name: "sous", variablePrefix: "--syn-" })],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    }),
  );
  return loading;
}

async function tokenize(code: string, lang: Lang): Promise<Token[][]> {
  const h = await highlighter();
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage((await LANGS[lang]()).default);
  return h.codeToTokensBase(code, { lang, theme: "sous" }).map((line) =>
    line.map((t) => {
      const style = t.fontStyle ?? 0;
      // Comments read in italic, and keywords in 500, as in the mock.
      return { text: t.content, color: t.color, italic: (style & 1) !== 0 || t.color === "var(--syn-token-comment)", strong: (style & 2) !== 0 || t.color === "var(--syn-token-keyword)" };
    }),
  );
}

// Past this size the text stays plain, so a huge file never holds up the page.
const MAX_CHARS = 120_000;

/** The code's lines as tokens, or null while shiki loads, for a language it doesn't know, or when it fails. */
export function useTokens(code: string, lang: Lang | undefined): Token[][] | null {
  const [done, setDone] = useState<{ code: string; lang: Lang; lines: Token[][] } | null>(null);
  useEffect(() => {
    if (!lang || code.length > MAX_CHARS) return;
    let live = true;
    tokenize(code, lang).then(
      (lines) => live && setDone({ code, lang, lines }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [code, lang]);
  return done && done.code === code && done.lang === lang ? done.lines : null;
}
