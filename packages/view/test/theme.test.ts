import { describe, expect, test } from "vitest";
import { applyTheme, nextThemePref, readThemePref, saveThemePref } from "../src/theme.ts";

describe("the theme", () => {
  test("follows the system until the person picks light or dark", () => {
    expect(readThemePref()).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("keeps a pick, and the system theme removes the override", () => {
    saveThemePref("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readThemePref()).toBe("dark");
    saveThemePref("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(readThemePref()).toBe("system");
  });

  test("ignores a stored value it does not know", () => {
    localStorage.setItem("sous.theme", "purple");
    expect(readThemePref()).toBe("system");
  });

  test("cycles system, light, dark", () => {
    expect(["system", "light", "dark"].map((p) => nextThemePref(p as "system"))).toEqual(["light", "dark", "system"]);
    const root = document.createElement("html");
    applyTheme("light", root);
    expect(root.getAttribute("data-theme")).toBe("light");
  });
});
