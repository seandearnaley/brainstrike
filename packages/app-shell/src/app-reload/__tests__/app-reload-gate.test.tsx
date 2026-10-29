import { useRequestAppReload } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppReloadGate } from '../app-reload-gate';
import { CHUNK_RELOAD_STORAGE_KEY } from '../chunk-reload-guard';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

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
      </AppReloadGate>
    </StrictMode>
  );
}

function requestReload(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Trigger reload' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe('AppReloadGate (the agent host owns the run)', () => {
  it('reloads immediately, with no dialog, whatever is running', () => {
    mountGate();

    requestReload();

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
    mountGate();

    requestReload();

    expect(reload).toHaveBeenCalledTimes(1);
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
    mountGate({ getStorage: () => blocked });

    requestReload();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('write'),
      expect.objectContaining({ error: expect.any(DOMException) })
    );
  });
});
