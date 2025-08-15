import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('feature flags url/env/localStorage precedence', () => {
  beforeEach(() => {
    // reset globals
    // Clear window without delete
    vi.unstubAllGlobals();
    for (const k of [
      'BRAINSTRIKE_URL_PARAMS',
      'VITE_FILE_EXPLORER_V2',
      'VITE_FILE_EXPLORER_V2_WORKER',
    ]) {
      (process.env as Record<string, string | undefined>)[k] = undefined;
    }
    try {
      // Reset localStorage if present
      try {
        (
          globalThis as unknown as { localStorage?: { clear?: () => void } }
        ).localStorage?.clear?.();
      } catch {}
    } catch {}
  });

  it('url presence-only enables worker (browser path)', async () => {
    vi.stubGlobal('window', {
      location: { search: '?ff_explorer_v2_worker' },
    } as unknown as Window);
    const { isFileExplorerV2WorkerEnabled } = await import('../feature-flags');
    expect(isFileExplorerV2WorkerEnabled()).toBe(true);
  });

  it('url presence-only enables V2 (browser path)', async () => {
    vi.stubGlobal('window', { location: { search: '?ff_explorer_v2' } } as unknown as Window);
    const { isFileExplorerV2Enabled } = await import('../feature-flags');
    expect(isFileExplorerV2Enabled()).toBe(true);
  });

  it('node path via BRAINSTRIKE_URL_PARAMS is honored', async () => {
    const { isFileExplorerV2WorkerEnabled } = await import('../feature-flags');
    process.env['BRAINSTRIKE_URL_PARAMS'] = 'ff_explorer_v2_worker=0';
    expect(isFileExplorerV2WorkerEnabled()).toBe(false);
  });

  it('shouldUseFileExplorerWorker true only when Worker API + both flags', async () => {
    vi.stubGlobal('window', {
      location: { search: '?ff_explorer_v2&ff_explorer_v2_worker' },
    } as unknown as Window);
    (globalThis as unknown as { Worker?: unknown }).Worker = (() => {}) as unknown;
    const { shouldUseFileExplorerWorker } = await import('../feature-flags');
    expect(shouldUseFileExplorerWorker()).toBe(true);
  });

  it('localStorage overrides env', async () => {
    vi.stubGlobal(
      'localStorage',
      (() => {
        let store: Record<string, string> = {};
        return {
          getItem: (k: string) => (k in store ? store[k] : null),
          setItem: (k: string, v: string) => {
            store[k] = String(v);
          },
          removeItem: (k: string) => {
            delete store[k];
          },
          clear: () => {
            store = {};
          },
        } as Storage;
      })()
    );
    localStorage.setItem('FEATURE_FILE_EXPLORER_V2_WORKER', '0');
    process.env['VITE_FILE_EXPLORER_V2_WORKER'] = '1';
    const { isFileExplorerV2WorkerEnabled } = await import('../feature-flags');
    expect(isFileExplorerV2WorkerEnabled()).toBe(false);
  });
});

import { isFileExplorerV2Enabled } from '../feature-flags';

describe('feature flags (env parsing)', () => {
  it('parses VITE_FILE_EXPLORER_V2 from process.env', () => {
    const old = process.env.VITE_FILE_EXPLORER_V2;
    process.env.VITE_FILE_EXPLORER_V2 = '1';
    expect(isFileExplorerV2Enabled()).toBe(true);
    process.env.VITE_FILE_EXPLORER_V2 = 'true';
    expect(isFileExplorerV2Enabled()).toBe(true);
    process.env.VITE_FILE_EXPLORER_V2 = '0';
    expect(isFileExplorerV2Enabled()).toBe(false);
    if (old === undefined) {
      // Restore to undefined state without delete operator
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error allow cleanup for test env
      process.env.VITE_FILE_EXPLORER_V2 = undefined;
    } else {
      process.env.VITE_FILE_EXPLORER_V2 = old;
    }
  });
});
