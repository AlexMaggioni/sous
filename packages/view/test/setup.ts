import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no matchMedia. The tests run as a wide screen in the light theme.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: /min-width/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom has no popovers, animations or ResizeObserver. These stubs, from the UI SDK testing
// docs, let a tooltip, menu, dialog or toast render. Check their real behavior in a browser.
HTMLElement.prototype.showPopover ??= function () {};
HTMLElement.prototype.hidePopover ??= function () {};
Element.prototype.getAnimations ??= () => [];
document.head.append(Object.assign(document.createElement("style"), { textContent: "[popover] { display: block !important }" }));
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
