/** E2E measurement only: Core remains the sole run writer. */
import type { HostClient } from '@brainstrike/agent-host/client';
import type { HostLogRow, HostParams, HostResults } from '@brainstrike/agent-host/protocol';

type RunInput = HostParams<'run/start'>;
interface Observer extends Pick<HostClient, 'close' | 'closed' | 'onEvent'> {
  subscribe(threadId: string): Promise<void>;
}
interface Dependencies {
  readonly now: () => number;
  readonly observer: Observer;
  readonly request: (input: RunInput) => Promise<HostResults['run/start']>;
  readonly threadId: string;
}
export interface HostAdmissionProbe {
  close(): Promise<void>;
  run(input: RunInput): Promise<number>;
}

export async function createHostAdmissionProbe({
  now,
  observer,
  request,
  threadId,
}: Dependencies): Promise<HostAdmissionProbe> {
  let active:
    | {
        runId: string | undefined;
        early: Map<string, HostLogRow>;
        terminal: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  let unavailable: unknown;
  const finish = (row: HostLogRow): void => {
    if (!active || row.threadId !== threadId || row.event.type !== 'run.finished') {
      return;
    }
    if (active.runId === undefined) {
      active.early.set(row.event.runId, row);
      return;
    }
    if (row.event.runId !== active.runId) {
      return;
    }
    if (row.event.outcome !== 'completed') {
      active.terminal.reject(new Error(`Foreground host run ended with ${row.event.outcome}`));
      return;
    }
    active.terminal.resolve();
  };
  const unsubscribe = observer.onEvent(finish);
  const fail = (cause: unknown): void => {
    unavailable = cause;
    active?.terminal.reject(cause);
  };
  void observer.closed.then(() => fail(new Error('Foreground host observer closed')), fail);
  try {
    await observer.subscribe(threadId);
  } catch (cause) {
    unsubscribe();
    try {
      await observer.close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Host probe subscription and retirement failed');
    }
    throw cause;
  }
  let running: Promise<number> | undefined;
  return {
    close: async () => {
      const retirement = new Error('Foreground host probe retired');
      const inFlight = running;
      fail(retirement);
      unsubscribe();
      const results = await Promise.allSettled([observer.close(), inFlight]);
      const causes = results.flatMap((result) =>
        result.status === 'rejected' && result.reason !== retirement ? [result.reason] : []
      );
      if (causes.length === 1) {
        throw causes[0];
      }
      if (causes.length > 1) {
        throw new AggregateError(causes, 'Host admission and observer retirement failed');
      }
    },
    run: (input) => {
      const execute = async (): Promise<number> => {
        if (unavailable !== undefined) {
          throw unavailable;
        }
        const pending = {
          early: new Map<string, HostLogRow>(),
          runId: undefined as string | undefined,
          terminal: Promise.withResolvers<void>(),
        };
        // Observe an early disconnect without an unhandled rejection while admission is pending.
        pending.terminal.promise.catch(() => undefined);
        active = pending;
        try {
          const started = now();
          const { runId } = await request(input);
          const admissionMs = now() - started;
          pending.runId = runId;
          const early = pending.early.get(runId);
          if (early) {
            finish(early);
          }
          pending.early.clear();
          await pending.terminal.promise;
          return admissionMs;
        } finally {
          active = undefined;
        }
      };
      running = execute().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
