import { useRequestAppReload } from '@brainstrike/ui';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode, useState, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningAssistantRunsState } from '../use-running-assistant-runs';

const { loggerMock, projectionStore, useRunningAssistantRunsMock } = vi.hoisted(() => {
  let state: RunningAssistantRunsState = { status: 'loading' };
  const listeners = new Set<() => void>();
  return {
    loggerMock: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    projectionStore: {
      get: () => state,
      set: (next: RunningAssistantRunsState) => {
        state = next;
        for (const listener of listeners) {
          listener();
        }
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    useRunningAssistantRunsMock: vi.fn(),
  };
});

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));
vi.mock('../use-running-assistant-runs', () => ({
  useRunningAssistantRuns: useRunningAssistantRunsMock,
}));

import { AppReloadGate } from '../app-reload-gate';
import { AppReloadPendingBanner } from '../app-reload-pending-banner';
import { CHUNK_RELOAD_STORAGE_KEY } from '../chunk-reload-guard';

const ready = (runningCount: number): RunningAssistantRunsState => ({
  runningCount,
  status: 'ready',
});
const LOADING: RunningAssistantRunsState = { status: 'loading' };
const QUERY_FAILURE = new Error('query failed');
const FAILED: RunningAssistantRunsState = { error: QUERY_FAILURE, status: 'error' };

const TITLE = 'Reload BrainStrike?';
const UNKNOWN_COPY =
  "BrainStrike can't confirm whether assistant runs are in progress. Reloading now stops any that are.";
const BANNER_COPY = 'BrainStrike will reload when the current run finishes.';

function setProjection(next: RunningAssistantRunsState): void {
  act(() => projectionStore.set(next));
}

function Trigger() {
  const requestAppReload = useRequestAppReload();
  return (
    <button onClick={() => requestAppReload()} type="button">
      Trigger reload
    </button>
  );
}

const reload = vi.fn<() => void>();

function mountGate(options: { getStorage?: () => Storage } = {}) {
  return render(
    <StrictMode>
      <AppReloadGate
        buildId="build-1"
        getStorage={options.getStorage ?? (() => window.sessionStorage)}
        reload={reload}
      >
        <Trigger />
        <AppReloadPendingBanner />
      </AppReloadGate>
    </StrictMode>
  );
}

function requestReload(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Trigger reload' }));
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: TITLE });
}

function clickInDialog(name: string): void {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  projectionStore.set(LOADING);
  useRunningAssistantRunsMock.mockImplementation(() =>
    useSyncExternalStore(projectionStore.subscribe, projectionStore.get)
  );
});

afterEach(() => {
  Reflect.deleteProperty(window, 'assistant');
});

describe('AppReloadGate on web (no run owner that survives a reload)', () => {
  it('reloads exactly once, with no dialog, when no assistant run is in flight', () => {
    projectionStore.set(ready(0));
    mountGate();

    requestReload();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before reloading when a run is in flight, and does not reload', () => {
    projectionStore.set(ready(1));
    mountGate();

    requestReload();

    expect(dialog()).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('says one run is still in progress, in the singular', () => {
    projectionStore.set(ready(1));
    mountGate();

    requestReload();

    expect(
      within(dialog()).getByText('1 assistant run is still in progress. Reloading now stops it.')
    ).toBeInTheDocument();
  });

  it('says how many runs are still in progress, in the plural', () => {
    projectionStore.set(ready(2));
    mountGate();

    requestReload();

    expect(
      within(dialog()).getByText(
        '2 assistant runs are still in progress. Reloading now stops them.'
      )
    ).toBeInTheDocument();
  });

  it('offers exactly Cancel, Reload now and Reload when finished for a known run count', () => {
    projectionStore.set(ready(1));
    mountGate();

    requestReload();

    const labels = within(dialog())
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((label) => label !== 'Close');
    expect(labels).toEqual(['Cancel', 'Reload now', 'Reload when finished']);
  });

  it('reloads once when the user picks Reload now', () => {
    projectionStore.set(ready(1));
    mountGate();
    requestReload();

    clickInDialog('Reload now');

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes without reloading when the user cancels', () => {
    projectionStore.set(ready(1));
    mountGate();
    requestReload();

    clickInDialog('Cancel');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('closes without reloading when the user dismisses the dialog with Escape', () => {
    projectionStore.set(ready(1));
    mountGate();
    requestReload();

    fireEvent.keyDown(dialog(), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  describe('Reload when finished', () => {
    it('waits behind a banner and reloads exactly once when the count reaches zero', () => {
      projectionStore.set(ready(2));
      mountGate();
      requestReload();

      clickInDialog('Reload when finished');

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent(BANNER_COPY);
      expect(reload).not.toHaveBeenCalled();

      setProjection(ready(1));
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByRole('status')).toHaveTextContent(BANNER_COPY);

      setProjection(ready(0));
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('stays at one reload when the projection keeps reporting after the reload was requested', () => {
      projectionStore.set(ready(1));
      mountGate();
      requestReload();
      clickInDialog('Reload when finished');
      setProjection(ready(0));
      expect(reload).toHaveBeenCalledTimes(1);

      // The page is still alive until the navigation lands; a fresh, equal snapshot must not re-fire.
      setProjection(ready(0));
      setProjection(ready(0));

      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('cancels from the banner, so reaching zero no longer reloads', () => {
      projectionStore.set(ready(1));
      mountGate();
      requestReload();
      clickInDialog('Reload when finished');

      fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('status')).toBeNull();
      setProjection(ready(0));
      expect(reload).not.toHaveBeenCalled();
    });

    it('reloads at once when the runs finished while the dialog was still open', () => {
      projectionStore.set(ready(1));
      mountGate();
      requestReload();
      setProjection(ready(0));

      clickInDialog('Reload when finished');

      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('shows the unknown-state dialog, and does not reload, when the count becomes unreadable', () => {
      projectionStore.set(ready(1));
      mountGate();
      requestReload();
      clickInDialog('Reload when finished');

      setProjection(FAILED);

      expect(dialog()).toHaveTextContent(UNKNOWN_COPY);
      expect(screen.queryByRole('status')).toBeNull();
      expect(reload).not.toHaveBeenCalled();
    });

    it('brings the banner back if the count becomes readable again while still running', () => {
      projectionStore.set(ready(1));
      mountGate();
      requestReload();
      clickInDialog('Reload when finished');
      setProjection(LOADING);
      expect(dialog()).toBeInTheDocument();

      setProjection(ready(3));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent(BANNER_COPY);
      expect(reload).not.toHaveBeenCalled();
    });

    it('cancels the wait from the unknown-state dialog', () => {
      projectionStore.set(ready(1));
      mountGate();
      requestReload();
      clickInDialog('Reload when finished');
      setProjection(FAILED);

      clickInDialog('Cancel');
      setProjection(ready(0));

      expect(reload).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('asks again, and Cancel drops the wait, when reload is requested while waiting', () => {
      projectionStore.set(ready(1));
      mountGate();
      requestReload();
      clickInDialog('Reload when finished');

      requestReload();
      expect(dialog()).toBeInTheDocument();
      clickInDialog('Cancel');
      setProjection(ready(0));

      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['loading', LOADING],
    ['failed', FAILED],
  ])('when the run count is %s', (_label, state) => {
    it('fails closed with the unknown-state dialog and never reloads by itself', () => {
      projectionStore.set(state);
      mountGate();

      requestReload();

      expect(dialog()).toHaveTextContent(UNKNOWN_COPY);
      expect(reload).not.toHaveBeenCalled();
    });

    it('offers only Cancel and Reload now, without a way to wait', () => {
      projectionStore.set(state);
      mountGate();
      requestReload();

      const labels = within(dialog())
        .getAllByRole('button')
        .map((button) => button.textContent)
        .filter((label) => label !== 'Close');
      expect(labels).toEqual(['Cancel', 'Reload now']);
    });

    it('does not reload when the count later reads zero underneath the open dialog', () => {
      projectionStore.set(state);
      mountGate();
      requestReload();

      setProjection(ready(0));

      expect(dialog()).toHaveTextContent(UNKNOWN_COPY);
      expect(reload).not.toHaveBeenCalled();
    });

    it('reloads once on Reload now', () => {
      projectionStore.set(state);
      mountGate();
      requestReload();

      clickInDialog('Reload now');

      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  it('logs why the count could not be read when it fails closed', () => {
    projectionStore.set(FAILED);
    mountGate();

    requestReload();

    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('could not be counted'), {
      error: QUERY_FAILURE,
      status: 'error',
    });
  });
});

describe('AppReloadGate on desktop (the main process owns the run)', () => {
  beforeEach(() => {
    window.assistant = { url: 'http://127.0.0.1:4111' };
    // Any read of the web projection would be a DB subscription desktop must not make.
    useRunningAssistantRunsMock.mockImplementation(() => {
      throw new Error('desktop must not read the web run projection');
    });
  });

  it('reloads immediately, with no dialog, whatever is running', () => {
    projectionStore.set(ready(3));
    mountGate();

    requestReload();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never shows the pending banner', () => {
    mountGate();

    requestReload();

    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the capability that picks the gate', () => {
  // The two gates are different component types around the whole shell, so an answer
  // that changed after the first render would unmount and remount the application.
  let mounts = 0;
  function MountProbe() {
    useState(() => {
      mounts += 1;
    });
    return <Trigger />;
  }

  function renderGate() {
    return (
      <AppReloadGate buildId="build-1" reload={reload}>
        <MountProbe />
      </AppReloadGate>
    );
  }

  beforeEach(() => {
    mounts = 0;
  });

  it('is read once, so window.assistant appearing later does not remount the tree, and web keeps asking', () => {
    projectionStore.set(ready(1));
    const { rerender } = render(renderGate());
    expect(mounts).toBe(1);

    window.assistant = { url: 'http://127.0.0.1:4111' };
    rerender(renderGate());
    requestReload();

    expect(mounts).toBe(1);
    expect(dialog()).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('is read once, so window.assistant going away later does not remount the tree, and desktop keeps reloading at once', () => {
    window.assistant = { url: 'http://127.0.0.1:4111' };
    useRunningAssistantRunsMock.mockImplementation(() => {
      throw new Error('desktop must not read the web run projection');
    });
    const { rerender } = render(renderGate());
    expect(mounts).toBe(1);

    Reflect.deleteProperty(window, 'assistant');
    rerender(renderGate());
    requestReload();

    expect(mounts).toBe(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the reload guard marker', () => {
  it('is written before the reload is requested', () => {
    let markerAtReload: string | null = 'not-called';
    reload.mockImplementation(() => {
      markerAtReload = window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    });
    projectionStore.set(ready(0));
    mountGate();

    requestReload();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(markerAtReload ?? 'null')).toEqual({ buildId: 'build-1' });
  });

  it('is written before a reload the user chose from the dialog', () => {
    let markerAtReload: string | null = 'not-called';
    reload.mockImplementation(() => {
      markerAtReload = window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    });
    projectionStore.set(ready(1));
    mountGate();
    requestReload();

    clickInDialog('Reload now');

    expect(JSON.parse(markerAtReload ?? 'null')).toEqual({ buildId: 'build-1' });
  });

  it('is written before a reload that waited for the runs to finish', () => {
    let markerAtReload: string | null = 'not-called';
    reload.mockImplementation(() => {
      markerAtReload = window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    });
    projectionStore.set(ready(1));
    mountGate();
    requestReload();
    clickInDialog('Reload when finished');

    setProjection(ready(0));

    expect(JSON.parse(markerAtReload ?? 'null')).toEqual({ buildId: 'build-1' });
  });

  it('is written before the immediate desktop reload', () => {
    window.assistant = { url: 'http://127.0.0.1:4111' };
    let markerAtReload: string | null = 'not-called';
    reload.mockImplementation(() => {
      markerAtReload = window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    });
    mountGate();

    requestReload();

    expect(JSON.parse(markerAtReload ?? 'null')).toEqual({ buildId: 'build-1' });
  });

  it('does not stop the reload when the marker cannot be written', () => {
    const blocked = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    } as unknown as Storage;
    projectionStore.set(ready(0));
    mountGate({ getStorage: () => blocked });

    requestReload();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('write'),
      expect.objectContaining({ error: expect.any(DOMException) })
    );
  });
});
