import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-preferences-store';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelMigrationNotices } from './use-model-migration-notices';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useToast: () => ({ toast: toastMock }),
  };
});

/**
 * BST-565. A persisted model id that the catalog retired is remapped during
 * store migration — correct, but a Pro → Flash swap the user never chose
 * must not be silent. The store records the remap; this hook surfaces it
 * ONCE and clears it.
 */
describe('useModelMigrationNotices', () => {
  beforeEach(() => {
    __resetAssistantPreferencesStoreForTests();
    toastMock.mockReset();
  });

  it('toasts each recorded remap once and clears the notices', () => {
    useAssistantPreferencesStore.setState({
      modelMigrationNotices: [
        { from: 'google/gemini-2.5-pro', provider: 'openrouter', to: 'google/gemini-2.5-flash' },
      ],
    });

    const { rerender } = renderHook(() => useModelMigrationNotices());

    expect(toastMock).toHaveBeenCalledTimes(1);
    const call = toastMock.mock.calls[0]?.[0] as { description: string; title: string };
    expect(call.title).toBe('Saved model replaced');
    expect(call.description).toContain('OpenRouter');
    expect(call.description).toContain('google/gemini-2.5-pro');
    expect(call.description).toContain('google/gemini-2.5-flash');
    expect(useAssistantPreferencesStore.getState().modelMigrationNotices).toEqual([]);

    rerender();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no remap was recorded', () => {
    renderHook(() => useModelMigrationNotices());
    expect(toastMock).not.toHaveBeenCalled();
  });
});
