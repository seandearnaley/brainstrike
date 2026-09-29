import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Module-level store: a fresh module graph per test (the `use-app-active` house style). */
async function loadFresh() {
  vi.resetModules();
  const [notice, context, provider, store] = await Promise.all([
    import('../app-reload-notice'),
    import('../app-reload-context'),
    import('../app-reload-provider'),
    import('../app-reload-store'),
  ]);
  return { ...notice, ...context, ...provider, ...store };
}

describe('useRequestAppReload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when no AppReloadProvider is mounted', async () => {
    const { useRequestAppReload } = await loadFresh();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Probe() {
      useRequestAppReload();
      return null;
    }

    expect(() => render(<Probe />)).toThrow(/AppReloadProvider/);
  });

  it('returns the provided requestAppReload', async () => {
    const { AppReloadProvider, useRequestAppReload } = await loadFresh();
    const requestAppReload = vi.fn();
    function Probe() {
      const request = useRequestAppReload();
      return (
        <button onClick={request} type="button">
          go
        </button>
      );
    }
    render(
      <AppReloadProvider requestAppReload={requestAppReload}>
        <Probe />
      </AppReloadProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    expect(requestAppReload).toHaveBeenCalledTimes(1);
  });
});

describe('AppReloadNotice', () => {
  async function mountNotice(requestAppReload: () => void = vi.fn()) {
    const modules = await loadFresh();
    const { AppReloadNotice, AppReloadProvider } = modules;
    render(
      <AppReloadProvider requestAppReload={requestAppReload}>
        <AppReloadNotice />
      </AppReloadProvider>
    );
    return modules;
  }

  it('renders nothing while no reload is required', async () => {
    await mountNotice();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the failed-to-load copy once a reload is required', async () => {
    const { appReloadStore } = await mountNotice();

    act(() => appReloadStore.markRequired());

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Part of BrainStrike failed to load. Reload the app to fix it.'
    );
    expect(screen.getByRole('button', { name: 'Reload app' })).toBeInTheDocument();
  });

  it('says reloading did not help when a reload was already attempted', async () => {
    const { appReloadStore } = await mountNotice();

    act(() => {
      appReloadStore.markRequired();
      appReloadStore.markReloadAlreadyAttempted();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Part of BrainStrike still can't load. Reloading didn't fix this."
    );
    expect(screen.getByRole('button', { name: 'Reload app' })).toBeInTheDocument();
  });

  it('requests an app reload when Reload app is pressed', async () => {
    const requestAppReload = vi.fn();
    const { appReloadStore } = await mountNotice(requestAppReload);
    act(() => appReloadStore.markRequired());

    fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));

    expect(requestAppReload).toHaveBeenCalledTimes(1);
  });

  it('throws when no AppReloadProvider is mounted, even while hidden', async () => {
    const { AppReloadNotice } = await loadFresh();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<AppReloadNotice />)).toThrow(/AppReloadProvider/);
  });
});
