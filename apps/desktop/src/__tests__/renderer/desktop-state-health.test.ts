// @vitest-environment happy-dom
import {
  BoundaryFailureError,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract/boundary-failure';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for this frame's host connection, driven by each test. */
type FakeConnectionState =
  | { readonly kind: 'idle' }
  | { readonly automatic: boolean; readonly kind: 'connecting' }
  | { readonly client: object; readonly kind: 'connected' }
  | { readonly error: string; readonly kind: 'failed' };

const { connection, request } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state: FakeConnectionState = { kind: 'idle' };
  let failure: unknown;
  const publish = (next: FakeConnectionState): void => {
    state = next;
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    connection: {
      fail(cause: Error): void {
        failure = cause;
        publish({ error: cause.message, kind: 'failed' });
      },
      get failure(): unknown {
        return failure;
      },
      listeners,
      publish,
      reconnect: vi.fn(),
      get state(): FakeConnectionState {
        return state;
      },
      subscribed: Promise.withResolvers<void>(),
    },
    request: vi.fn(),
  };
});
vi.mock('../../renderer/desktop-host-connection', () => ({
  windowHostConnection: () => ({
    current: async () => {
      if (connection.state.kind === 'failed') {
        throw connection.failure;
      }
      return connection.state.kind === 'connected' ? connection.state.client : { request };
    },
    getSnapshot: () => connection.state,
    reconnect: connection.reconnect,
    replacement: () => new Promise(() => undefined),
    subscribe: (listener: () => void) => {
      connection.listeners.add(listener);
      connection.subscribed.resolve();
      return () => connection.listeners.delete(listener);
    },
  }),
}));

import { createDesktopStateHealth } from '../../renderer/desktop-state-health';

// BST-1880: a host left running by an older build lacks `state/health/read`.
// It cannot report health, which is neither damage nor a claim of health.

function withBridges(): void {
  Object.assign(window, {
    agentHost: { connect: vi.fn() },
    agentHostRecovery: {
      restartHost: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      showDataFolder: vi.fn(),
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
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

  it('shows the relaunched host’s connection failure at once, without a second attempt or a deadline', async () => {
    vi.useFakeTimers();
    withBridges();
    connection.publish({ client: { request }, kind: 'connected' });
    const restarting = createDesktopStateHealth()?.restartHost();
    // Main has replied; the old client's close now starts the automatic attempt, which fails.
    await connection.subscribed.promise;
    connection.publish({ automatic: true, kind: 'connecting' });
    connection.fail(new Error('The agent host connection was refused'));

    expect(vi.getTimerCount()).toBe(0);
    await expect(restarting).rejects.toThrow('The agent host connection was refused');
    expect(connection.reconnect).not.toHaveBeenCalled();
  });
});
