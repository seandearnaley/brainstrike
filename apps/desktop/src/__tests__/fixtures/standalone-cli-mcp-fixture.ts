import { processStartTime, RootLock } from '@brainstrike/state-store';
import { expect } from 'vitest';

export interface StandaloneCliResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}
export type StandaloneCli = (args: readonly string[]) => Promise<StandaloneCliResult>;

/** Owns admitted CLI calls and the fixture host, including failed discovery startup. */
export function createStandaloneCliMcpFixture(dataRoot: string, command: StandaloneCli) {
  const pending = new Set<Promise<StandaloneCliResult>>();
  let closing: Promise<void> | undefined;

  const run: StandaloneCli = (args) => {
    if (closing) {
      return Promise.reject(new Error('MCP CLI fixture is closing'));
    }
    const running = command(args).finally(() => {
      pending.delete(running);
    });
    pending.add(running);
    return running;
  };

  const release = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const outcome of await Promise.allSettled(pending)) {
      if (outcome.status === 'rejected') {
        errors.push(outcome.reason);
      }
    }
    try {
      const owner = RootLock.inspect(dataRoot)?.owner;
      if (owner && !owner.released && processStartTime(owner.pid) === owner.start) {
        try {
          expect(await command(['host', 'stop'])).toMatchObject({ code: 0 });
        } catch (cause) {
          errors.push(cause);
        }
        await expect.poll(() => processStartTime(owner.pid)).toBeNull();
      }
    } catch (cause) {
      errors.push(cause);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'MCP CLI fixture cleanup failed');
    }
  };

  const close = (): Promise<void> => {
    closing ??= release();
    return closing;
  };
  return { close, run };
}
