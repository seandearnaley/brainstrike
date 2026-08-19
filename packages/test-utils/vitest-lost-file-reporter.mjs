// BST-1221: fail the lane when a test file finishes the run with NO verdict.
//
// THE FAILURE THIS CATCHES
// -----------------------
// A vitest worker can die mid-run without unwinding — a V8 fatal
// (`Check failed: jit_page_->allocations_.erase(addr)` →
// `ThreadIsolation::UnregisterWasmAllocation` → `V8_Fatal`, seen repeatedly on
// Node 24.18.1 in the WASM-heavy lanes), or an OOM kill (BST-1072). The test
// file that worker was executing never reports anything.
//
// What vitest does with that, measured on 4.1.10 (see the PR for the captured
// runs):
//
//   * the lost module IS present at `onTestRunEnd`, with `state() === 'pending'`;
//   * the run's own verdict is `reason: 'passed'`;
//   * the summary line reads `Test Files 2 passed (3)` — a PASS phrasing whose
//     only hint is a parenthesised total that does not match;
//   * the process exits non-zero ONLY through the separate unhandled-errors
//     path (`[vitest-pool]: Worker exited unexpectedly`).
//
// That last point is the whole reason this reporter exists. The non-zero exit
// is not a property of the results — it is a side effect of an error channel
// that `dangerouslyIgnoreUnhandledErrors: true` switches off. With that single
// flag set, a run that silently dropped an entire test file exits 0 and reads
// as green. This reporter makes the missing verdict fail on its own merits,
// independent of that channel, and names the file so the run is triaged
// instead of reflexively rerun.
//
// A plain `.mjs` at the package root (like `vitest.base.mjs` and
// `workspace-src-aliases.mjs`): reporters are loaded by the vitest NODE
// process before any package build, so this must not depend on `dist/`.

/** Run outcomes where unfinished modules are expected rather than lost. */
const NON_DIAGNOSTIC_REASONS = new Set(['interrupted']);

/**
 * Test modules that never produced a verdict.
 *
 * `pending` at run end means the module was collected and never resolved to
 * passed/failed/skipped — the signature of a worker that died holding it.
 * An INTERRUPTED run (Ctrl-C, or a bail) legitimately leaves modules unstarted,
 * so it is excluded: reporting those would be noise, not a lost file.
 *
 * @param {ReadonlyArray<{ moduleId: string, state: () => string }>} testModules
 * @param {string} reason `TestRunEndReason` — 'passed' | 'failed' | 'interrupted'.
 * @returns {string[]} module ids with no verdict, in collection order.
 */
export function findLostTestFiles(testModules, reason) {
  if (NON_DIAGNOSTIC_REASONS.has(reason)) {
    return [];
  }
  return testModules.filter((module) => module.state() === 'pending').map((m) => m.moduleId);
}

/**
 * Render the operator-facing diagnostic. Kept separate from the reporter so its
 * exact wording is testable and so the message stays in one place.
 *
 * @param {string[]} lostFiles
 * @returns {string}
 */
export function formatLostTestFileReport(lostFiles) {
  const list = lostFiles.map((file) => `  - ${file}`).join('\n');
  return [
    '',
    '⎯⎯⎯⎯⎯⎯ Lost test files (BST-1221) ⎯⎯⎯⎯⎯⎯',
    '',
    `${lostFiles.length} test file(s) finished this run with NO verdict — not passed, not`,
    'failed, not skipped. They were collected and then never reported, which means the',
    'worker executing them died mid-run (V8 fatal during WASM teardown, or an OOM kill).',
    '',
    list,
    '',
    'The summary above UNDERCOUNTS: those files contributed no result, so a green-looking',
    '"N passed" line does not cover them. Do NOT rerun without reading the log first —',
    'look for a native stack trace (V8_Fatal / ThreadIsolation) or',
    '"[vitest-pool]: Worker exited unexpectedly" above. Record the occurrence on BST-1221.',
    '',
    'Failing the run because a file with no verdict cannot be called a pass.',
    '',
  ].join('\n');
}

/**
 * Vitest reporter enforcing "every collected file reports a verdict".
 *
 * Registered via `reporters` in a package vitest config; see
 * `scripts/verify-lost-file-reporter.mjs`, which enforces that every package
 * test config registers it so the guarantee cannot be dropped by omission.
 */
export default class LostTestFileReporter {
  /** @type {boolean} */
  #watchMode = false;

  /** @param {{ config?: { watch?: boolean } }} vitest */
  onInit(vitest) {
    // In watch mode the process is long-lived and an exit code is meaningless;
    // still print, so an interactive crash is visible.
    this.#watchMode = vitest?.config?.watch === true;
  }

  /**
   * @param {ReadonlyArray<{ moduleId: string, state: () => string }>} testModules
   * @param {ReadonlyArray<unknown>} _unhandledErrors
   * @param {string} reason
   */
  onTestRunEnd(testModules, _unhandledErrors, reason) {
    const lostFiles = findLostTestFiles(testModules, reason);
    if (lostFiles.length === 0) {
      return;
    }
    process.stderr.write(formatLostTestFileReport(lostFiles));
    if (!this.#watchMode) {
      process.exitCode = 1;
    }
  }
}
