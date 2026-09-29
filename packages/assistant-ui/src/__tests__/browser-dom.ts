// Shared helpers for browser-lane DOM assertions. Extracted from
// `activity-step-row.browser.test.tsx` and `activity-trace.browser.test.tsx`,
// which each defined identical copies (BST-1685) — keep any future browser
// test importing from here instead of adding a third copy.

/** Parses a computed-style pixel string (e.g. `"12px"`) into a number. */
export function px(value: string): number {
  return Number.parseFloat(value);
}

/**
 * Like `container.querySelector`, but throws a readable error instead of
 * handing back `null` disguised as an element via an `as` cast. Typed as
 * `Element` (not `HTMLElement`) so it also matches SVG nodes — e.g. a
 * chevron's geometry class landing on the `<svg>` itself, an `SVGElement`.
 */
export function mustFind(container: ParentNode, selector: string): Element {
  const el = container.querySelector(selector);
  if (el === null) {
    throw new Error(`mustFind: no element matched "${selector}"`);
  }
  return el;
}
