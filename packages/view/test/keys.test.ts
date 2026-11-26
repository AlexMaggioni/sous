import { describe, expect, test } from "vitest";
import { pressOf, readKey, SHORTCUTS, type KeyPress, type KeyState } from "../src/shell/keys.ts";

const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({ key, meta: false, ctrl: false, alt: false, shift: false, repeat: false, typing: false, layered: false, ...more });
const IDLE: KeyState = { gAt: null };

/** What a row of keys does, pressed `gap` milliseconds apart. */
function pressAll(keys: (string | KeyPress)[], gap = 100) {
  let state = IDLE;
  const actions = [];
  for (const [i, key] of keys.entries()) {
    const read = readKey(typeof key === "string" ? press(key) : key, state, 1000 + i * gap);
    state = read.state;
    if (read.action) actions.push(read.action);
  }
  return actions;
}

describe("the shortcuts", () => {
  test("g then a section key goes to that section", () => {
    expect(pressAll(["g", "r"])).toEqual([{ type: "go", path: "/runs" }]);
    expect(pressAll(["g", "w"])).toEqual([{ type: "go", path: "/workflows" }]);
    expect(pressAll(["g", "a"])).toEqual([{ type: "go", path: "/agents" }]);
    expect(pressAll(["g", "s"])).toEqual([{ type: "go", path: "/skills" }]);
    expect(pressAll(["g", "m"])).toEqual([{ type: "go", path: "/mcp" }]);
  });

  test("a section key alone, or after g waited too long, goes nowhere", () => {
    expect(pressAll(["w"])).toEqual([]);
    expect(pressAll(["g", "w"], 2000)).toEqual([]);
    expect(pressAll(["g", "x", "w"])).toEqual([]);
  });

  test("j and k move in the list, and keep moving while held", () => {
    expect(pressAll(["j", "k", press("j", { repeat: true })])).toEqual([
      { type: "move", delta: 1 },
      { type: "move", delta: -1 },
      { type: "move", delta: 1 },
    ]);
  });

  test("/ searches, ? shows the help, and Escape closes", () => {
    expect(pressAll(["/", press("?", { shift: true }), "Escape"])).toEqual([{ type: "filter" }, { type: "help" }, { type: "close" }]);
  });

  test("⌘K and Ctrl+K open the jump menu, ⌘B and Ctrl+B toggle the list", () => {
    expect(pressAll([press("k", { meta: true }), press("k", { ctrl: true })])).toEqual([{ type: "jump" }, { type: "jump" }]);
    expect(pressAll([press("b", { meta: true }), press("B", { ctrl: true })])).toEqual([{ type: "sidebar" }, { type: "sidebar" }]);
  });

  test("a held ⌘K fires once, and other modified keys do nothing", () => {
    expect(pressAll([press("k", { meta: true, repeat: true }), press("j", { meta: true }), press("k", { meta: true, shift: true }), press("g", { alt: true })])).toEqual([]);
  });

  test("a shifted letter is not a shortcut", () => {
    expect(pressAll([press("J", { shift: true }), "g", press("W", { shift: true })])).toEqual([]);
  });

  test("the help lists every section's g key", () => {
    expect(SHORTCUTS.filter((s) => s.keys.startsWith("g ")).map((s) => s.does)).toEqual(["Go to runs", "Go to workflows", "Go to agents", "Go to skills", "Go to MCP servers"]);
  });
});

describe("while the person types or a layer is open", () => {
  test("no letter, / or ? fires in a field", () => {
    const typing = (key: string) => press(key, { typing: true });
    expect(pressAll([typing("g"), typing("w"), typing("j"), typing("/"), typing("?"), typing("Escape")])).toEqual([]);
  });

  test("g pressed in a field does not wait for the next key outside it", () => {
    expect(pressAll([press("g", { typing: true }), "w"])).toEqual([]);
  });

  test("⌘K and ⌘B still work in a field, since they type nothing", () => {
    expect(pressAll([press("k", { meta: true, typing: true }), press("b", { ctrl: true, typing: true })])).toEqual([{ type: "jump" }, { type: "sidebar" }]);
  });

  test("nothing fires inside a dialog or a menu", () => {
    const layered = (key: string, more: Partial<KeyPress> = {}) => press(key, { layered: true, ...more });
    expect(pressAll([layered("j"), layered("g"), layered("r"), layered("k", { meta: true }), layered("Escape")])).toEqual([]);
  });
});

describe("reading a keydown", () => {
  const keydown = (target: Element, key = "g") => {
    let read: KeyPress | undefined;
    target.addEventListener("keydown", (event) => (read = pressOf(event as KeyboardEvent)), { once: true });
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    return read as KeyPress;
  };

  test("a text field, a text area and editable text count as typing, a checkbox does not", () => {
    document.body.innerHTML = `<input id="t" type="search"><textarea id="a"></textarea><div id="e" contenteditable="true"><span id="s">x</span></div><input id="c" type="checkbox"><button id="b">Go</button>`;
    const typing = (id: string) => keydown(document.getElementById(id) as Element).typing;
    expect([typing("t"), typing("a"), typing("s"), typing("c"), typing("b")]).toEqual([true, true, true, false, false]);
  });

  test("an element inside a dialog or a menu counts as layered", () => {
    document.body.innerHTML = `<div role="dialog"><button id="d">OK</button></div><div role="menu"><div id="m" role="menuitem">Pick</div></div><button id="out">Out</button>`;
    const layered = (id: string) => keydown(document.getElementById(id) as Element).layered;
    expect([layered("d"), layered("m"), layered("out")]).toEqual([true, true, false]);
  });
});
