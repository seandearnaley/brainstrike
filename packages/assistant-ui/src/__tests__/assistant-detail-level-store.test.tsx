import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  useAssistantDetailLevel,
  useAssistantDetailLevelStore,
} from '../assistant-detail-level-store.ts';

/** Reads `localStorage` again into a fresh store, as the app does when it reopens. */
async function reopen() {
  const saved = localStorage.getItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY);
  // Emptying the store saves its defaults; put back what the last session saved.
  useAssistantDetailLevelStore.setState(useAssistantDetailLevelStore.getInitialState(), true);
  if (saved === null) {
    localStorage.removeItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY);
  } else {
    localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, saved);
  }
  await useAssistantDetailLevelStore.persist.rehydrate();
  return renderHook(() => useAssistantDetailLevel());
}

describe('the assistant Detail level', () => {
  it('opens on standard when nothing was chosen', async () => {
    const { result } = await reopen();
    expect(result.current.detailLevel).toBe('standard');
  });

  it('keeps the chosen level across a reopen', async () => {
    const first = await reopen();
    act(() => first.result.current.setDetailLevel('developer'));
    expect(first.result.current.detailLevel).toBe('developer');
    first.unmount();

    const { result } = await reopen();
    expect(result.current.detailLevel).toBe('developer');
  });

  it('opens on standard when the saved level is one this build does not know', async () => {
    localStorage.setItem(
      ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
      JSON.stringify({ state: { detailLevel: 'bogus' }, version: 1 })
    );
    const { result } = await reopen();
    expect(result.current.detailLevel).toBe('standard');
  });

  it('opens on standard when the saved value is unreadable', async () => {
    localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, 'developer');
    const { result } = await reopen();
    expect(result.current.detailLevel).toBe('standard');
  });
});
