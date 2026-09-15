import type { AssistantClient } from '@assistant-ui/react';
import { describe, expectTypeOf, it } from 'vitest';

/**
 * `use-approval-notice-state.ts` reports a failed decision from the synchronous
 * `try/catch` around `aui.thread().append(...)` and from nowhere else, because
 * the installed assistant-ui returns `void` here: it detaches its own promise
 * and rethrows a failed run or history write from a handler no caller can
 * reach (those reach `unhandledrejection`). A failed run is observed instead
 * through thread state (`resolveApprovalRunOutcome` → `retryable`).
 *
 * If a version bump ever returns a promise from `append`, this assertion fails
 * at type-check, and the notice's failure path has to be revisited rather than
 * silently losing the rejection.
 */
describe('assistant-ui thread().append contract', () => {
  it('returns void, so there is no rejection for the approval notice to catch', () => {
    // Type-only: `expectTypeOf` evaluates its argument, and a client exists
    // only at runtime inside a provider. `thread` is a scope accessor on
    // `AssistantClient` (`ClientScopes & { ... }`), not an overload set, so
    // `ReturnType` resolves the same signature the notice calls.
    expectTypeOf<ReturnType<AssistantClient['thread']>['append']>().returns.toBeVoid();
  });
});
