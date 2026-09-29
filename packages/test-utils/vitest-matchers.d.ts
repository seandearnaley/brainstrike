import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import 'vitest';

// Vitest 5 exposes Matchers<R, T>; jest-dom 7 still augments the old Assertion<T>.
// Use the public extension interface without changing runtime matchers.
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<T, R> {}
}
