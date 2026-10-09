import { joinHostClosingRun } from './core-run-lifecycle.js';
import type { HostRunState } from './core-state.js';

/** Core emits this only after its admission fence and every physical owner joined.
 * Incident: https://github.com/seandearnaley/brainstrike/pull/3543#issuecomment-6053571110
 * Outcome failures remain failures; they do not keep a joined writer alive.
 */
export class HostCoreRetiredError extends AggregateError {
  constructor(causes: readonly unknown[]) {
    super(causes, 'Host cleanup failed after physical retirement');
  }
}

/**
 * Host close: fence pending admissions and runs, wait out the admission tail,
 * join every run's task, effects and owner, then the platform. Returns the
 * runs' retained outcomes once nothing failed to retire.
 */
export async function retireHostCoreRuns(options: {
  readonly admission: () => Promise<void>;
  readonly closeOwner: (run: HostRunState) => Promise<void>;
  readonly closePlatform: () => Promise<void>;
  readonly failedAdmissions: () => readonly unknown[];
  readonly finish: (run: HostRunState) => Promise<void>;
  readonly pendingAdmissions: Iterable<AbortController>;
  readonly runs: () => readonly HostRunState[];
}): Promise<readonly unknown[]> {
  for (const controller of options.pendingAdmissions) {
    controller.abort(new Error('Host is closing'));
  }
  for (const run of options.runs()) {
    run.controller.abort(new Error('Host is closing'));
  }
  await options.admission();
  for (const run of options.runs()) {
    run.controller.abort(new Error('Host is closing'));
  }
  const joined = await Promise.allSettled(
    options.runs().map((run) => joinHostClosingRun(run, options.closeOwner, options.finish))
  );
  const platform = await Promise.allSettled([options.closePlatform()]);
  const outcomes = hostRunClosingOutcomes(joined);
  const failures = [
    ...options.failedAdmissions(),
    ...[...joined, ...platform]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason),
  ];
  if (failures.length > 0) {
    throw new AggregateError([...outcomes, ...failures], 'Host cleanup failed');
  }
  for (const run of options.runs()) {
    run.release?.();
    run.release = undefined;
  }
  return outcomes;
}

export function hostRunClosingOutcomes(
  joined: readonly PromiseSettledResult<readonly unknown[]>[]
): readonly unknown[] {
  return joined.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

export function reportRetiredHostOutcomes(outcomes: readonly unknown[]): void {
  if (outcomes.length > 0) {
    throw new HostCoreRetiredError(outcomes);
  }
}

/** Runtime alone owns the canonical store closure after Core's verified joins. */
export async function closeHostStoreAfterCore(
  closeCore: () => Promise<void>,
  closeStore: () => Promise<void>
): Promise<void> {
  let outcome: HostCoreRetiredError | undefined;
  try {
    await closeCore();
  } catch (cause) {
    if (!(cause instanceof HostCoreRetiredError)) {
      throw cause;
    }
    outcome = cause;
  }
  try {
    await closeStore();
  } catch (cause) {
    if (outcome) {
      throw new AggregateError([outcome, cause], 'Host outcome and writer cleanup failed');
    }
    throw cause;
  }
  if (outcome) {
    throw outcome;
  }
}
