import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
  useAssistantDetailLevel,
} from '../assistant-detail-level-context';

const wrapper = ({ children }: { children: ReactNode }) => (
  <AssistantDetailLevelProvider>{children}</AssistantDetailLevelProvider>
);

describe('AssistantDetailLevelProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to standard when nothing is persisted', () => {
    const { result } = renderHook(() => useAssistantDetailLevel(), { wrapper });
    expect(result.current.detailLevel).toBe('standard');
  });

  it('updates and persists the chosen level', () => {
    const { result } = renderHook(() => useAssistantDetailLevel(), { wrapper });

    act(() => result.current.setDetailLevel('developer'));

    expect(result.current.detailLevel).toBe('developer');
    expect(window.localStorage.getItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY)).toBe('developer');
  });

  it('rehydrates a previously persisted level', () => {
    window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, 'compact');
    const { result } = renderHook(() => useAssistantDetailLevel(), { wrapper });
    expect(result.current.detailLevel).toBe('compact');
  });

  it('ignores a corrupt persisted value and falls back to standard', () => {
    window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, 'bogus');
    const { result } = renderHook(() => useAssistantDetailLevel(), { wrapper });
    expect(result.current.detailLevel).toBe('standard');
  });

  it('returns the standard default when used without a provider', () => {
    const { result } = renderHook(() => useAssistantDetailLevel());
    expect(result.current.detailLevel).toBe('standard');
  });
});
