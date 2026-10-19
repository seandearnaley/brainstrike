import { connect } from 'node:net';
import { vi } from 'vitest';

/** Resolves once the host's endpoint refuses a new connection: its transport is retiring. */
export const refusesConnections = (endpoint: string): Promise<void> =>
  vi.waitFor(
    () =>
      new Promise<void>((resolve, reject) => {
        const probe = connect(endpoint);
        probe.once('connect', () => {
          probe.destroy();
          reject(new Error('The host still accepts connections'));
        });
        probe.once('error', () => resolve());
      }),
    { interval: 5, timeout: 30_000 }
  );
