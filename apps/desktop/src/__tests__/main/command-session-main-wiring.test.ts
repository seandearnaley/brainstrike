import { describe, expect, it, vi } from 'vitest';
import { installMainBootFixture, shutdownPlanCapture } from './boot-order-fixture';

describe('command session manager lifecycle wiring', () => {
  installMainBootFixture();
  it('configures the current root resolver and joins command retirement during shutdown and reset', async () => {
    const manager = await import('../../assistant-server/command-session-manager');
    const configure = vi.spyOn(manager, 'configureDesktopCommandSessionManager');
    const held = Promise.withResolvers<number>();
    const dispose = vi
      .spyOn(manager, 'disposeDesktopCommandSessions')
      .mockReturnValue(held.promise);
    const resetModule = await import('../../desktop-reset-platform');
    const createReset = vi.spyOn(resetModule, 'createDesktopFactoryResetHandler');
    const roots = await import('../../git-ipc-handlers');
    const resolve = vi.spyOn(roots, 'createWorkspaceRootResolver');
    try {
      await import('../../main');
      expect(configure).toHaveBeenCalledOnce();
      expect(configure.mock.calls[0]?.[0].resolver).toBe(resolve.mock.results[0]?.value);
      const plan = shutdownPlanCapture.current?.();
      if (!plan) {
        throw new Error('Main did not publish its shutdown owner');
      }
      let closed = false;
      const close = Promise.resolve(
        plan.steps['child-processes'](new AbortController().signal)
      ).then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      expect(closed).toBe(false);
      held.resolve(0);
      await close;
      expect(closed).toBe(true);
      const commandRuntime = createReset.mock.calls[0]?.[0].runtimes.find(
        (entry) => entry.name === 'command-sessions'
      );
      if (!commandRuntime) {
        throw new Error('Reset did not register command retirement');
      }
      const failure = new Error('Command physical retirement failed');
      dispose.mockRejectedValueOnce(failure);
      await expect(commandRuntime.stop()).rejects.toBe(failure);
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally {
      held.resolve(0);
      vi.restoreAllMocks();
    }
  });
});
