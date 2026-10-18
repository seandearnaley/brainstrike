// @vitest-environment happy-dom
import {
  BoundaryFailureError,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract/boundary-failure';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../renderer/desktop-host-connection', () => ({
  windowHostConnection: () => ({ current: async () => ({ request }) }),
}));

import { createDesktopStateHealth } from '../../renderer/desktop-state-health';

// BST-1880: a host left running by an older build lacks `state/health/read`.
// It cannot report health, which is neither damage nor a claim of health.

function withBridges(): void {
  Object.assign(window, {
    agentHost: { connect: vi.fn() },
    agentHostRecovery: { restartHost: vi.fn(), showDataFolder: vi.fn() },
  });
}

afterEach(() => {
  request.mockReset();
  Reflect.deleteProperty(window, 'agentHost');
  Reflect.deleteProperty(window, 'agentHostRecovery');
});

describe('createDesktopStateHealth', () => {
  it('is absent without the desktop bridges', () => {
    expect(createDesktopStateHealth()).toBeNull();
  });

  it('reads the running host’s health', async () => {
    withBridges();
    request.mockResolvedValueOnce({ damagedThreads: 0, stateDamage: null });

    await expect(createDesktopStateHealth()?.read()).resolves.toEqual({
      damagedThreads: 0,
      stateDamage: null,
    });
    expect(request).toHaveBeenCalledWith('state/health/read', {});
  });

  it('reads a host without the method as unable to report, not as healthy or failed', async () => {
    withBridges();
    request.mockRejectedValueOnce(
      new BoundaryFailureError(INTERNAL_FAULT, {
        cause: Object.assign(new Error('Unhandled method state/health/read'), { code: -32_601 }),
      })
    );

    await expect(createDesktopStateHealth()?.read()).resolves.toBeNull();
  });

  it('still surfaces any other read failure', async () => {
    withBridges();
    request.mockRejectedValueOnce(new BoundaryFailureError(INTERNAL_FAULT));

    await expect(createDesktopStateHealth()?.read()).rejects.toBeInstanceOf(BoundaryFailureError);
  });
});
