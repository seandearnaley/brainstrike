import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-preferences-store';
import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
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

const NOTICE = {
  from: 'google/gemini-2.5-pro',
  provider: 'openrouter',
  to: 'google/gemini-2.5-flash',
} as const;

/**
 * BST-565. A persisted model id that the catalog retired is remapped during
 * store migration — correct, but a Pro → Flash swap the user never chose
 * must not be silent. The store records the remap; this hook surfaces it
 * ONCE and clears it, however many times the effect runs.
 */
describe('useModelMigrationNotices', () => {
  beforeEach(() => {
    __resetAssistantPreferencesStoreForTests();
    toastMock.mockReset();
  });

  it('toasts each recorded remap once and clears the notices', () => {
    useAssistantPreferencesStore.setState({ modelMigrationNotices: [NOTICE] });

    const { rerender } = renderHook(() => useModelMigrationNotices());

    expect(toastMock).toHaveBeenCalledTimes(1);
    const call = toastMock.mock.calls[0]?.[0] as {
      description: string;
      persistent?: boolean;
      title: string;
    };
    expect(call.title).toBe('Saved model replaced');
    // Startup notice: must not vanish on the 5s default before it is read.
    expect(call.persistent).toBe(true);
    expect(call.description).toContain('OpenRouter');
    expect(call.description).toContain('google/gemini-2.5-pro');
    expect(call.description).toContain('google/gemini-2.5-flash');
    expect(useAssistantPreferencesStore.getState().modelMigrationNotices).toEqual([]);

    rerender();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces notices that arrive after mount (async hydration)', () => {
    renderHook(() => useModelMigrationNotices());
    expect(toastMock).not.toHaveBeenCalled();

    act(() => {
      useAssistantPreferencesStore.setState({ modelMigrationNotices: [NOTICE] });
    });

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(useAssistantPreferencesStore.getState().modelMigrationNotices).toEqual([]);
  });

  it('toasts once under StrictMode double-invoked effects', () => {
    useAssistantPreferencesStore.setState({ modelMigrationNotices: [NOTICE] });

    renderHook(() => useModelMigrationNotices(), { wrapper: StrictMode });

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('toasts once when several instances mount in the same commit', () => {
    useAssistantPreferencesStore.setState({ modelMigrationNotices: [NOTICE] });

    renderHook(() => {
      useModelMigrationNotices();
      useModelMigrationNotices();
      useModelMigrationNotices();
    });

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no remap was recorded', () => {
    renderHook(() => useModelMigrationNotices());
    expect(toastMock).not.toHaveBeenCalled();
  });
});
