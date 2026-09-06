/**
 * Typed accessors for global slots the ambient lib types declare read-only.
 *
 * `Worker`, `ErrorEvent`, and `localStorage` are `declare const` in the DOM
 * lib, so every test that installs a stub first has to widen `globalThis`.
 * Written inline that produced the same `as unknown as { … }` shape at ten
 * call sites across the worker-storage suites (BST-459). Both functions below
 * are the single place that widening happens; call sites name the slot and the
 * type they expect and carry no cast of their own.
 *
 * Not a general-purpose utility: this is test-only support for overriding
 * environment globals, and it lives beside the tests that need it.
 */

type GlobalSlotRecord<T> = Record<string, T | undefined>;

function slots<T>(): GlobalSlotRecord<T> {
  return globalThis as unknown as GlobalSlotRecord<T>;
}

/** Read a global slot so it can be restored after the test. */
export function readGlobalSlot<T>(key: string): T | undefined {
  return slots<T>()[key];
}

/** Install (or, with `undefined`, remove) a global slot for the test. */
export function setGlobalSlot<T>(key: string, value: T | undefined): void {
  slots<T>()[key] = value;
}
