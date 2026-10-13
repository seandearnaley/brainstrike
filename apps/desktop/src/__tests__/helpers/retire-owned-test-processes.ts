export interface OwnedTestProcess {
  readonly kind: 'app' | 'child' | 'command';
  readonly pid: number;
  readonly start: string;
}

export interface OwnedTestProcessPorts {
  readonly join: (owner: OwnedTestProcess) => Promise<void>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly startTime: (pid: number) => string | null;
}

/** Failed cooperative cleanup stays a failure even if physical retirement succeeds. */
export async function retireOwnedTestProcesses(
  owners: readonly OwnedTestProcess[],
  ports: OwnedTestProcessPorts
): Promise<void> {
  const remaining = owners.filter(
    (owner, index) =>
      owners.findIndex((other) => other.pid === owner.pid && other.start === owner.start) ===
        index && ports.startTime(owner.pid) === owner.start
  );
  if (remaining.length === 0) {
    return;
  }
  const failures: unknown[] = [new Error('Owned app or Root process remains live')];
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
