/** Core emits this only after its admission fence and every physical owner joined.
 * Incident: https://github.com/seandearnaley/brainstrike/pull/3543#issuecomment-6053571110
 * Outcome failures remain failures; they do not keep a joined writer alive.
 */
export class HostCoreRetiredError extends AggregateError {
  constructor(causes: readonly unknown[]) {
    super(causes, 'Host cleanup failed after physical retirement');
  }
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
