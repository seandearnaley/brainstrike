import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopHostConnection } from '../../renderer/desktop-host-connection';

vi.mock('../../renderer/desktop-host-connection', () => ({
  windowHostConnection: () => {
    throw new Error('The test supplies the host capability');
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('distinguishes producer, canonical persistence and host-close waits at the existing close callback', async () => {
  vi.resetModules();
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let prepare: (() => Promise<void>) | undefined;
  vi.stubGlobal('window', {
    agentHost: {
      onPrepareClose: (callback: () => Promise<void>) => {
        prepare = callback;
      },
    },
    brainstrikeWorkspacePhaseTrace: true,
  });
  vi.stubGlobal('document', { body: { inert: false } });
  const producer = Promise.withResolvers<void>();
  const adapter = Promise.withResolvers<void>();
  const host = Promise.withResolvers<void>();
  const connection: DesktopHostConnection = {
    close: () => host.promise,
    current: async () => {
      throw new Error('unused');
    },
    getSnapshot: () => ({ kind: 'idle' }),
    reconnect: () => {},
    replacement: async () => {
      throw new Error('unused');
    },
    subscribe: () => () => {},
  };
  const close = await import('@brainstrike/app-state/renderer-close');
  close.registerRendererClosePreparation(async () => await producer.promise);
  close.registerRendererClosePreparation(async () => await adapter.promise, 'persistence');
  const { installDesktopRendererClose } = await import('../../renderer/desktop-renderer-close');
  installDesktopRendererClose(connection);
  if (!prepare) {
    throw new Error('Close preparation was not registered');
  }
  let done = false;
  const closing = prepare().then(() => {
    done = true;
  });
  const phases = () =>
    output.mock.calls.map(
      ([line]) => JSON.parse(String(line).slice('[document-close-proof] '.length)).phase
    );
  await vi.waitFor(() =>
    expect(phases()).toEqual(['renderer-prepare-begin', 'renderer-producers-begin'])
  );
  producer.resolve();
  await vi.waitFor(() => expect(phases().at(-1)).toBe('renderer-persistence-begin'));
  adapter.resolve();
  await vi.waitFor(() => expect(phases().at(-1)).toBe('host-connection-close-begin'));
  expect(done).toBe(false);
  expect(phases()).toContain('renderer-prepare-end');
  host.resolve();
  await closing;
  expect(phases().at(-1)).toBe('host-connection-close-end');
});
