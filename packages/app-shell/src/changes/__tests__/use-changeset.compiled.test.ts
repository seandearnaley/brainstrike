import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes-bridge';
import { useChangesLiveRefreshStore } from '../changes-live-refresh-store';
import { useChangeset } from '../use-changeset';

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useChangesLiveRefreshStore.getState().reset();
});

describe('useChangeset under the React Compiler', () => {
  it('resolves an inline changeset once, not again on the render its own result causes', async () => {
    const resolveView = vi.fn(async () => ({ error: 'snapshot missing', ok: false }) as const);
    // `resolveChangesBridge` requires a fully formed bridge.
    const bridge: ChangesBridge = {
      fileDiff: vi.fn(),
      inventory: vi.fn(),
      onInvalidated: vi.fn(() => () => {}),
      resolveView,
    };
    (window as unknown as { changes?: ChangesBridge }).changes = bridge;

    const { result } = renderHook(() =>
      useChangeset('root-1', { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' })
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.error).toBe('snapshot missing');
    expect(resolveView).toHaveBeenCalledOnce();
  });
});
