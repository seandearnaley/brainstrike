/**
 * The host gate shared by the three REAL-fence integration suites
 * (`fence-executor`, `run-python-tool`, and the BST-1071 escape-resistance red
 * team).
 *
 * All three need an actual OS sandbox: Seatbelt on macOS, bubblewrap on Linux.
 * `SandboxManager.checkDependenciesAsync()` is srt's own probe for whether the
 * host can supply one — on Linux it requires `bwrap`, `socat` (srt's network
 * bridge) and `rg` (its mandatory-deny scan) on `PATH`.
 *
 * **Why this is a shared module and not three copies.** For months every Linux
 * CI run printed
 *
 *     SUITE SKIPPED — sandbox-runtime dependencies are missing on this linux
 *     host: ripgrep (rg) not found, bubblewrap (bwrap) not installed, socat
 *     not installed
 *
 * and stayed GREEN, while `docs/agents/code-execution.md` and the suite's own
 * README both required an srt bump to be re-greened on macOS *and* Linux. A
 * skip is the correct answer on a developer laptop that has no bwrap; it is
 * the WRONG answer in a lane that was built to run these suites. The
 * difference cannot be inferred from the host — only the lane knows what it
 * promised — so the lane declares it, and this gate escalates accordingly.
 */

import { env, platform } from 'node:process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

/**
 * Set to `'1'` by a CI lane that installs the Linux fence dependencies (see
 * the `unit-shard` job in `.github/workflows/test.yml`). It converts "the host
 * cannot run these suites" from a skip into a hard failure, because in that
 * lane an unmet prerequisite is a LANE DEFECT — the runner image changed, or
 * the install step was dropped — not a host to be tolerated. Unset everywhere
 * else, so laptops and the coverage lanes keep the loud-skip behaviour.
 */
export const FENCE_DEPS_REQUIRED_ENV = 'BRAINSTRIKE_FENCE_DEPS_REQUIRED';

/**
 * `undefined` when this host can run a real fence; otherwise the reason,
 * phrased for the `console.warn` each suite prints before skipping.
 *
 * Deliberately does NOT escalate on its own. Each suite has prerequisites this
 * module cannot see — an interpreter on `PATH`, unsandboxed reachability of
 * the probe host — and every one of them skips the suite just as completely as
 * a missing `bwrap` does. Escalating here would have covered only the
 * dependency case and left the others able to report a green lane that ran no
 * security proofs, which is the whole bug. {@link refuseToSkipInAPromisedLane}
 * is the single choke point that sees the COMPLETE reason.
 */
export async function describeFenceHostSkipReason(): Promise<string | undefined> {
  if (platform !== 'darwin' && platform !== 'linux') {
    return `the OS fence requires macOS (Seatbelt) or Linux (bubblewrap); this host is '${platform}'`;
  }

  const deps = await SandboxManager.checkDependenciesAsync();
  if (deps.errors.length > 0) {
    return `sandbox-runtime dependencies are missing on this ${platform} host: ${deps.errors.join(', ')}`;
  }
  return;
}

/**
 * The gate every real-fence suite funnels its FINAL skip decision through.
 *
 * Returns the reason unchanged (so the caller still `console.warn`s it and
 * `describe.skipIf`s on it) — except in a lane that set
 * {@link FENCE_DEPS_REQUIRED_ENV}, where it throws instead. A module-scope
 * throw fails collection of the importing spec file, which is exactly the
 * intent: the lane goes red rather than reporting a security suite it never
 * ran.
 *
 * **Every suite-wide skip escalates, not just the dependency one.** The gate
 * originally threw only for missing srt dependencies, which left three ways to
 * reach a green required lane having proven nothing: no `python3` on `PATH`
 * (all three suites), and an unreachable probe host (which skips
 * `fence-executor` and `run-python-tool` in their entirety, filesystem and
 * process-tree proofs included). Raised in review of the BST-1316 PR.
 *
 * The network prerequisite is the debatable one, because it depends on hosts
 * this repo does not control, so a transient outage reds a required lane. That
 * is accepted deliberately: the failure names itself ("… is not reachable
 * UNSANDBOXED …") and a reader can tell in one line that it is not a code
 * defect, whereas the silent skip it replaces is undiagnosable by
 * construction. If it ever does prove flaky, the fix is a more robust probe —
 * not a return to reporting green on unrun security tests.
 */
export function refuseToSkipInAPromisedLane(
  suite: string,
  reason: string | undefined
): string | undefined {
  if (!reason || env[FENCE_DEPS_REQUIRED_ENV] !== '1') {
    return reason;
  }
  throw new Error(
    `[${suite}] refusing to skip: ${reason}. ${FENCE_DEPS_REQUIRED_ENV}=1, so this lane PROMISED the prerequisites for the real-fence suites — reporting green without running them is the failure this flag exists to prevent. Fix the lane (see the "Install the Linux OS-fence dependencies" step in .github/workflows/test.yml) rather than clearing the variable.`
  );
}
