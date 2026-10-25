import { CHILD_CLOSE_BUDGET_MS, CHILD_SIGNAL_GRACE_MS } from '@brainstrike/state-store';

export interface OwnedTestProcess {
  readonly kind: 'app' | 'child' | 'command';
  readonly pid: number;
  readonly start: string;
}

export interface OwnedTestProcessPorts {
  /** Resolves at the process's OS exit; never bounded by a clock of its own. */
  readonly join: (owner: OwnedTestProcess) => Promise<void>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly startTime: (pid: number) => string | null;
}

/**
 * ADR-0030: once its owner closed, a child closes within the close budget and its tree ends
 * within the signal grace after that. A process may still be exiting when cleanup starts;
 * only one that outlives that guarantee is left behind.
 */
const OWNER_EXIT_GUARANTEE_MS = CHILD_CLOSE_BUDGET_MS + CHILD_SIGNAL_GRACE_MS;

async function exitsWithinGuarantee(
  owner: OwnedTestProcess,
  ports: OwnedTestProcessPorts
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      ports.join(owner).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), OWNER_EXIT_GUARANTEE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A process left behind stays a failure even if physical retirement then succeeds. */
export async function retireOwnedTestProcesses(
  owners: readonly OwnedTestProcess[],
  ports: OwnedTestProcessPorts
): Promise<void> {
  const live = owners.filter(
    (owner, index) =>
      owners.findIndex((other) => other.pid === owner.pid && other.start === owner.start) ===
        index && ports.startTime(owner.pid) === owner.start
  );
  const exited = await Promise.all(live.map((owner) => exitsWithinGuarantee(owner, ports)));
  const remaining = live.filter((_owner, index) => !exited[index]);
  if (remaining.length === 0) {
    return;
  }
  const failures: unknown[] = [new Error('Owned app or Root process outlived its owner')];
  const results = await Promise.allSettled(
    remaining.map(async (owner) => {
      if (ports.startTime(owner.pid) !== owner.start) {
        return;
      }
      try {
        ports.signal(owner.pid, owner.kind === 'command' ? 'SIGKILL' : 'SIGTERM');
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) {
          throw cause;
        }
      }
      await ports.join(owner);
    })
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
  throw new AggregateError(failures, 'Owned test process cleanup failed');
}
