/**
 * Typed accessors for global slots the ambient lib types declare read-only.
 *
 * `Worker`, `ErrorEvent`, and `localStorage` are `declare const` in the DOM
 * lib, so every test that installs a stub first has to widen `globalThis`.
 * Writing that widening inline produced the same `as unknown as { … }` shape
 * at ten call sites across the worker-storage suites (BST-459). The two
 * functions below are the single place it happens; call sites name the slot
 * and the type they expect and carry no cast of their own.
 *
 * Not a general-purpose utility: this is test-only support for overriding
 * environment globals, and it lives beside the tests that need it. The slot
 * names are a closed union so a typo cannot quietly create a new global
 * instead of overriding an existing one.
 */

/** The environment globals the worker-storage suites stub. */
type GlobalSlotName = 'ErrorEvent' | 'localStorage' | 'Worker';

function slots<T>(): Record<GlobalSlotName, T | undefined> {
  return globalThis as unknown as Record<GlobalSlotName, T | undefined>;
}

/** Read a global slot so the test can restore it afterwards. */
export function readGlobalSlot<T>(key: GlobalSlotName): T | undefined {
  return slots<T>()[key];
}

/**
 * Assign a global slot for the test.
 *
 * Passing `undefined` ASSIGNS undefined — it does not remove the property, so
 * `'Worker' in globalThis` stays true. A test that needs a global genuinely
 * absent (a capability probe using `in`, which is this repo's feature-gating
 * idiom) must use `Reflect.deleteProperty(globalThis, key)` instead, the way
 * the teardown in worker-storage.coverage.test.ts does.
 */
export function setGlobalSlot<T>(key: GlobalSlotName, value: T | undefined): void {
  slots<T>()[key] = value;
}
