/**
 * The real-process test budgets, in one dependency-free module that both
 * `vitest.config.mts` and the real-bin fixture import, so every budget scales
 * with `TEST_TIMEOUT_MULTIPLIER` (and `DEBUG`) together.
 */
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';

/**
 * One budget for each real-process step: a bin invocation, and each wait on a
 * process it started (an exit, a Root release). 15 s, or 30 s on the nightly
 * (`TEST_TIMEOUT_MULTIPLIER=2`). Unthrottled, `host start` takes about 1 s; on
 * the hosted 2-vCPU coverage runner, about 10 s (BST-2157), at the 10 s
 * `execFile` guards these suites used and far past `expect.poll`'s 1 s default.
 *
 * A test budget, not a product bound. The product's own deadlines (the
 * launcher's 10 s startup, the starter's 10 s readiness) still run inside the
 * bin, and a missed one fails the command with its own error.
 */
export const REAL_PROCESS_TIMEOUT_MS = getAdjustedTimeout('integration');

/**
 * The most budgeted steps an `afterEach` runs in sequence for the one Root a
 * test leaves: `retireRootOwner`'s CLI stop and then its exit wait, or a
 * Root-release wait and then an exit wait.
 */
export const CLEANUP_STEPS = 2;

/**
 * `hookTimeout` covers cleanup's sequential waits four times over, so a
 * cleanup that runs out fails with its own error, not Vitest's hook timeout.
 * That is 120 s (the package's fixed value before BST-2157, which its other
 * hooks were sized for), or 240 s on the nightly.
 */
export const HOOK_TIMEOUT_MS = 4 * CLEANUP_STEPS * REAL_PROCESS_TIMEOUT_MS;

/**
 * A real-bin test makes up to 15 bin calls: 5 s unthrottled, 48 s on the
 * hosted coverage runner. Four step budgets: 60 s, or 120 s on the nightly.
 */
export const TEST_TIMEOUT_MS = 4 * REAL_PROCESS_TIMEOUT_MS;
