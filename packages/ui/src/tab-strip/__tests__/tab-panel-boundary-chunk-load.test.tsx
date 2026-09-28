import { fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The registry and the reload store are module-level state, so every test loads
 * a fresh module graph (the `use-app-active` house style).
 */
async function loadFresh() {
  vi.resetModules();
  const [boundary, chunkLoad] = await Promise.all([
    import('../tab-panel-boundary'),
    import('../../chunk-load'),
  ]);
  return { ...boundary, ...chunkLoad };
}

type Fresh = Awaited<ReturnType<typeof loadFresh>>;

/** Reports `payload` the way Vite's preload helper does when a dynamic import fails. */
function reportPreloadError(fresh: Fresh, payload: unknown): void {
  const uninstall = fresh.installChunkLoadErrorListener(window);
  const event = new Event('vite:preloadError', { cancelable: true });
  Object.assign(event, { payload });
  window.dispatchEvent(event);
  uninstall();
}

/** Mounts a boundary around a lazy component whose import rejects with `error`. */
async function renderRejectedLazy(
  fresh: Fresh,
  error: Error,
  options: { layout?: 'inline' | 'panel'; requestAppReload?: () => void } = {}
) {
  const factory = vi.fn(() => Promise.reject<{ default: () => null }>(error));
  const Broken = lazy(factory);
  render(
    <fresh.AppReloadProvider requestAppReload={options.requestAppReload ?? vi.fn()}>
      <fresh.TabPanelBoundary label="Changes" layout={options.layout ?? 'panel'}>
        <Suspense fallback={null}>
          <Broken />
        </Suspense>
      </fresh.TabPanelBoundary>
    </fresh.AppReloadProvider>
  );
  await screen.findByRole('alert');
  return { factory };
}

describe('TabPanelBoundary with a failed lazy chunk', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  beforeEach(() => {
    writeText.mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    writeText.mockReset();
  });

  it('offers Reload app instead of Reload tab for a registered chunk-load error', async () => {
    const fresh = await loadFresh();
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/panel.js');
    reportPreloadError(fresh, error);
    const requestAppReload = vi.fn();

    await renderRejectedLazy(fresh, error, { requestAppReload });

    expect(screen.getByRole('alert')).toHaveTextContent("Changes couldn't load");
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Part of BrainStrike failed to download, usually after an update or a dropped connection. Reload the app to fix it.'
    );
    expect(screen.queryByRole('button', { name: 'Reload tab' })).toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Reload app',
      'Copy details',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));

    expect(requestAppReload).toHaveBeenCalledTimes(1);
  });

  it('copies the crash details from the chunk-load variant', async () => {
    const fresh = await loadFresh();
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/panel.js');
    reportPreloadError(fresh, error);
    await renderRejectedLazy(fresh, error);
    expect(screen.getByRole('alert')).toHaveTextContent("Changes couldn't load");

    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain(
      'Changes: TypeError: Failed to fetch dynamically imported module: /assets/panel.js'
    );
  });

  it('keeps Reload tab for an error Vite never reported', async () => {
    const fresh = await loadFresh();

    await renderRejectedLazy(fresh, new Error('plain render crash'));

    expect(screen.getByRole('alert')).toHaveTextContent('Changes stopped working');
    expect(screen.getByRole('button', { name: 'Reload tab' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload app' })).toBeNull();
  });

  it('points at Copy details once a reload was already attempted', async () => {
    const fresh = await loadFresh();
    const error = new TypeError('Failed to fetch dynamically imported module');
    reportPreloadError(fresh, error);
    fresh.appReloadStore.markReloadAlreadyAttempted();

    await renderRejectedLazy(fresh, error);

    expect(screen.getByRole('alert')).toHaveTextContent("Changes still can't load");
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Reloading didn't fix this. Copy the details and report the problem."
    );
    expect(screen.queryByRole('button', { name: 'Reload tab' })).toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Copy details',
      'Reload app',
    ]);
  });

  it('fits the chunk-load variant on one strip row in inline layout', async () => {
    const fresh = await loadFresh();
    const error = new TypeError('Failed to fetch dynamically imported module');
    reportPreloadError(fresh, error);
    const requestAppReload = vi.fn();

    await renderRejectedLazy(fresh, error, { layout: 'inline', requestAppReload });

    expect(screen.getByRole('alert')).toHaveTextContent("Changes couldn't load");
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
    expect(requestAppReload).toHaveBeenCalledTimes(1);
  });

  // Characterisation (passes today): why the chunk-load variant exists. React.lazy
  // caches the rejected import, so remounting the same lazy identity rethrows the
  // same error without ever re-running the import. "Reload tab" cannot recover it.
  it('shows the fallback again when Reload tab remounts a rejected lazy', async () => {
    const fresh = await loadFresh();

    const { factory } = await renderRejectedLazy(fresh, new Error('chunk 404'));
    fireEvent.click(screen.getByRole('button', { name: 'Reload tab' }));

    expect(await screen.findByRole('button', { name: 'Reload tab' })).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
