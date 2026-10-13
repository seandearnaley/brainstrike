import {
  addLogListener,
  configureLogger,
  LogLevel,
  type LogRecord,
  resetLogger,
} from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWindowFocusBridge,
  WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS,
} from '../window-focus-bridge.js';

// This package's vitest environment is `node`: a stubbed `globalThis.window`
// carries the bridge, as in browser-download.test.ts.
function setBridge(value: unknown): void {
  vi.stubGlobal('window', { windowFocus: value });
}

describe('resolveWindowFocusBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetLogger();
  });

  it('is null outside a window (workers, Node) without complaint', () => {
    expect(resolveWindowFocusBridge()).toBeNull();
  });

  it('is null when the capability is absent (web, hidden hosts) without complaint', () => {
    vi.stubGlobal('window', {});
    configureLogger({ console: false });
    const records: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      records.push(record);
    });
    try {
      expect(resolveWindowFocusBridge()).toBeNull();
    } finally {
      removeListener();
    }
    expect(records).toEqual([]);
  });

  it('decodes focus and preserves the push subscription when it has every required method', async () => {
    const bridge = {
      isFocused: () => Promise.resolve({ ok: true as const, value: true }),
      onChange: () => () => undefined,
    };
    setBridge(bridge);
    const capability = resolveWindowFocusBridge();
    await expect(capability?.isFocused()).resolves.toBe(true);
    expect(capability?.onChange).toBe(bridge.onChange);
  });

  it.each([
    ['isFocused', { onChange: () => () => undefined }, ['isFocused']],
    ['onChange', { isFocused: () => Promise.resolve(true) }, ['onChange']],
    ['a non-function member', { isFocused: true, onChange: () => () => undefined }, ['isFocused']],
  ])(
    'reports a malformed bridge (%s) as an error and treats it as absent',
    (_label, value, missing) => {
      configureLogger({ console: false });
      const records: LogRecord[] = [];
      const removeListener = addLogListener((record) => {
        records.push(record);
      });
      setBridge(value);
      try {
        expect(resolveWindowFocusBridge()).toBeNull();
      } finally {
        removeListener();
      }
      const [record] = records;
      expect(record?.level).toBe(LogLevel.ERROR);
      expect(record?.scope).toBe('WindowFocusBridge');
      expect(record?.message).toContain('window.windowFocus bridge is malformed');
      expect(record?.args).toContainEqual({ missing });
    }
  );

  it('reports every required method for a null bridge', () => {
    configureLogger({ console: false });
    const records: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      records.push(record);
    });
    setBridge(null);
    try {
      expect(resolveWindowFocusBridge()).toBeNull();
    } finally {
      removeListener();
    }
    expect(records[0]?.args).toContainEqual({ missing: [...WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS] });
  });
});
