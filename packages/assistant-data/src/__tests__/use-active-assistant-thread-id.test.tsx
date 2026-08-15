import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '../assistant-memory-resource';
import {
  resetAssistantThreadStore,
  useActiveAssistantThreadId,
  useAssistantThreadStore,
} from '../assistant-thread-store';

describe('useActiveAssistantThreadId', () => {
  afterEach(() => {
    resetAssistantThreadStore();
  });

  it('returns null when no thread is active', () => {
    const { result } = renderHook(() => useActiveAssistantThreadId());
    expect(result.current).toBeNull();
  });

  it('tracks the workspace resource active thread', () => {
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-1' },
    });
    const { result } = renderHook(() => useActiveAssistantThreadId());
    expect(result.current).toBe('thread-1');
  });
});
