import { describe, expect, it, vi } from 'vitest';
import { installMainBootFixture, shutdownPlanCapture } from './boot-order-fixture';

// BST-2250: git, gh and every Windows git command's native Job join must be
// settled before Main lets Electron free its Node environment.
describe('git command shutdown wiring', () => {
  installMainBootFixture();
  it('joins every live Windows git command from its git-commands shutdown step', async () => {
    const commands = await import('../../git-command-windows');
    const held = Promise.withResolvers<number>();
    const dispose = vi
      .spyOn(commands, 'disposeLiveWindowsGitCommands')
      .mockReturnValue(held.promise);
    try {
      await import('../../main');
      const plan = shutdownPlanCapture.current?.();
      if (!plan) {
        throw new Error('Main did not publish its shutdown owner');
      }
      let joined = false;
      const step = Promise.resolve(plan.steps['git-commands']()).then(() => {
        joined = true;
      });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      expect(joined).toBe(false);
      held.resolve(0);
      await step;
      expect(joined).toBe(true);

      const failure = new Error('Windows git Job join failed');
      dispose.mockRejectedValueOnce(failure);
      await expect(plan.steps['git-commands']()).rejects.toBe(failure);
    } finally {
      held.resolve(0);
      vi.restoreAllMocks();
    }
  });
});
