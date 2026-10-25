import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  stubChangesBridge,
  workspaceGitWrapper,
} from '../../__tests__/helpers/workspace-git-services-wrapper';
import { useChangesLiveRefreshStore } from '../changes-live-refresh-store';
import { useChangeset } from '../use-changeset';

afterEach(() => {
  useChangesLiveRefreshStore.getState().reset();
});

describe('useChangeset under the React Compiler', () => {
  it('resolves an inline changeset once, not again on the render its own result causes', async () => {
    const resolveView = vi.fn(async () => ({ error: 'snapshot missing', ok: false }) as const);
    const wrapper = workspaceGitWrapper({ changes: stubChangesBridge({ resolveView }) });

    const { result } = renderHook(
      () => useChangeset('root-1', { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' }),
      { wrapper }
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.error).toBe('snapshot missing');
    expect(resolveView).toHaveBeenCalledOnce();
  });
});
