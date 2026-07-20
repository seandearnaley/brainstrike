import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PanelPersistenceAdapter } from '../hooks/panel-persistence-adapters';
import { useLoadPanelState } from '../hooks/use-load-panel-state';

const DEFAULT_SIZES = [25, 55, 20];

describe('useLoadPanelState hydration failure surfacing', () => {
  const capturedWarnings: LogRecord[] = [];
  let removeLogListener: () => void;

  beforeEach(() => {
    capturedWarnings.length = 0;
    removeLogListener = addLogListener((record) => {
      if (record.scope === 'UseLoadPanelState' && record.level === LogLevel.WARN) {
        capturedWarnings.push(record);
      }
    });
  });

  afterEach(() => {
    removeLogListener();
  });

  it('warns with context and still hydrates defaults when the adapter load fails', async () => {
    // NOTE: failure is injected through a rejecting adapter, not by spying on
    // happy-dom's localStorage (its Proxy makes prototype spies silently never
    // fire — a false-green). The built-in LocalStorage/Electron adapters
    // absorb their own load failures and report them at the adapter layer
    // (see panel-persistence-adapters.test.ts), so a rejecting custom adapter
    // is what exercises this hook's own catch.
    const failingAdapter: PanelPersistenceAdapter = {
      load: () => Promise.reject(new Error('corrupted panel state payload')),
      save: () => Promise.resolve(),
    };

    const { result } = renderHook(() =>
      useLoadPanelState(DEFAULT_SIZES, false, true, false, failingAdapter)
    );

    // Default-hydration behavior is preserved: the hook settles on defaults
    // instead of throwing or staying un-hydrated.
    await waitFor(() => {
      expect(result.current[3]).toBe(true);
    });
    expect(result.current[0]).toEqual({
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
      sizes: DEFAULT_SIZES,
    });

    // ...but the discarded persisted state is surfaced, not silently eaten.
    expect(capturedWarnings).toHaveLength(1);
    expect(capturedWarnings[0]?.args[0]).toContain('panel state');
    expect(JSON.stringify(capturedWarnings[0]?.args[1])).toContain('corrupted panel state payload');
  });

  it('does not warn when the adapter loads successfully', async () => {
    const adapter: PanelPersistenceAdapter = {
      load: () =>
        Promise.resolve({
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [30, 40, 30],
        }),
      save: () => Promise.resolve(),
    };

    const { result } = renderHook(() =>
      useLoadPanelState(DEFAULT_SIZES, false, true, false, adapter)
    );

    await waitFor(() => {
      expect(result.current[3]).toBe(true);
    });
    expect(result.current[0].sizes).toEqual([30, 40, 30]);
    expect(capturedWarnings).toHaveLength(0);
  });
});
