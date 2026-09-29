import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/** Module-level store: a fresh module graph per test (the `use-app-active` house style). */
async function loadFresh() {
  vi.resetModules();
  return await import('../app-reload-store');
}

describe('appReloadStore', () => {
  it('starts with no reload required and no reload attempted', async () => {
    const { appReloadStore } = await loadFresh();

    expect(appReloadStore.getSnapshot()).toEqual({
      reloadAlreadyAttempted: false,
      required: false,
    });
  });

  it('notifies subscribers when a reload becomes required', async () => {
    const { appReloadStore } = await loadFresh();
    const listener = vi.fn();
    appReloadStore.subscribe(listener);

    appReloadStore.markRequired();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(appReloadStore.getSnapshot()).toEqual({ reloadAlreadyAttempted: false, required: true });
  });

  it('notifies subscribers when a reload was already attempted', async () => {
    const { appReloadStore } = await loadFresh();
    const listener = vi.fn();
    appReloadStore.subscribe(listener);

    appReloadStore.markReloadAlreadyAttempted();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(appReloadStore.getSnapshot()).toEqual({ reloadAlreadyAttempted: true, required: false });
  });

  it('keeps the snapshot identity and stays quiet when a mark changes nothing', async () => {
    const { appReloadStore } = await loadFresh();
    appReloadStore.markRequired();
    const before = appReloadStore.getSnapshot();
    const listener = vi.fn();
    appReloadStore.subscribe(listener);

    appReloadStore.markRequired();

    expect(listener).not.toHaveBeenCalled();
    expect(appReloadStore.getSnapshot()).toBe(before);
  });

  it('stops notifying an unsubscribed listener', async () => {
    const { appReloadStore } = await loadFresh();
    const listener = vi.fn();
    const unsubscribe = appReloadStore.subscribe(listener);
    unsubscribe();

    appReloadStore.markRequired();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('useAppReloadState', () => {
  it('re-renders when the store changes', async () => {
    const { appReloadStore, useAppReloadState } = await loadFresh();
    function Probe() {
      const { reloadAlreadyAttempted, required } = useAppReloadState();
      return (
        <p data-testid="state">
          {String(required)}/{String(reloadAlreadyAttempted)}
        </p>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('false/false');

    act(() => appReloadStore.markRequired());
    expect(screen.getByTestId('state')).toHaveTextContent('true/false');

    act(() => appReloadStore.markReloadAlreadyAttempted());
    expect(screen.getByTestId('state')).toHaveTextContent('true/true');
  });
});
