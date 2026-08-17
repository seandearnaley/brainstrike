/**
 * Types for the values browser projects hand to the page through
 * `test.provide` (see `createBrowserProject` in @brainstrike/config).
 *
 * Vitest declares `ProvidedContext` as an empty interface, so `inject(key)`
 * resolves to `never` in any program that has not seen this augmentation.
 * Keeping it in one importable module — rather than repeating the `declare
 * module` block per consumer — means the publisher and every reader are typed
 * from a single definition and cannot drift apart.
 *
 * Import for the side effect on the type system only; there is no runtime
 * value here.
 */
declare module 'vitest' {
  interface ProvidedContext {
    /** @testing-library/dom async-utility budget, in milliseconds. */
    asyncUtilTimeout: number;
  }
}

export {};
