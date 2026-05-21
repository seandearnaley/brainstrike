import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  getPanelElements,
  resetLayoutState,
  resolveNetworkIdleTimeout,
  resolveWaitForAppLoadTimeout,
  resolveWaitForDatabaseReadyTimeout,
  waitForAppLoad,
  waitForDatabaseReady,
} from '../layout-helpers';

describe('layout-helpers (unit)', () => {
  async function withCiEnv<T>(isCI: boolean, callback: () => Promise<T> | T): Promise<T> {
    const originalCI = process.env['CI'];
    const originalGitHubActions = process.env['GITHUB_ACTIONS'];
    const hadCI = Object.hasOwn(process.env, 'CI');
    const hadGitHubActions = Object.hasOwn(process.env, 'GITHUB_ACTIONS');

    process.env['CI'] = isCI ? 'true' : 'false';
    process.env['GITHUB_ACTIONS'] = isCI ? 'true' : 'false';

    try {
      return await callback();
    } finally {
      if (hadCI) {
        process.env['CI'] = originalCI;
      } else {
        Reflect.deleteProperty(process.env, 'CI');
      }

      if (hadGitHubActions) {
        process.env['GITHUB_ACTIONS'] = originalGitHubActions;
      } else {
        Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
      }
    }
  }

  it('getPanelElements returns expected locators', () => {
    const locator = vi.fn((sel: string) => ({ sel }));
    const page = {
      locator,
      getByRole: vi.fn((role: string, opts?: Record<string, unknown>) => ({ role, opts })),
      getByText: vi.fn((txt: string) => ({ txt })),
      getByPlaceholder: vi.fn((txt: string) => ({ txt })),
    } as unknown as Page;
    const els = getPanelElements(page);
    expect(els.leftPanel).toBeDefined();
    expect(els.middlePanel).toBeDefined();
    expect(els.hideAgentPanelButton).toBeDefined();
    expect(els.showRightPanelShim).toBeDefined();
    // Shape checks are sufficient; underlying calls are exercised by construction
  });

  it('waitForAppLoad waits for key selectors', async () => {
    const waited: string[] = [];
    const loadStates: string[] = [];
    const page = {
      waitForLoadState: vi.fn(async (state: string) => void loadStates.push(state)),
      waitForSelector: vi.fn(async (sel: string) => void waited.push(sel)),
      waitForFunction: vi.fn(async () => ({
        dispose: vi.fn(async () => undefined),
        jsonValue: vi.fn(async () => 'connected'),
      })),
      // CI debug listeners (no-op in unit tests)
      on: vi.fn(),
    } as unknown as Page;
    await waitForAppLoad(page, { timeoutMs: 10_000 });
    // Using 'load' instead of 'domcontentloaded' to ensure JS bundles are loaded
    // before checking React elements (important for CI with vite preview)
    expect(loadStates).toContain('load');
    // Best-effort networkidle wait for deferred script loading
    expect(loadStates).toContain('networkidle');
    // Readiness check now supports both id and data-panel-id based panel markers.
    expect(
      waited.some(
        (selector) =>
          selector.includes('#agent-workspace-middle-panel') || selector.includes('#middle-panel')
      )
    ).toBe(true);
    expect(
      waited.some(
        (selector) =>
          selector.includes('#agent-workspace-main-content-panel') ||
          selector.includes('#main-content-panel')
      )
    ).toBe(true);
    expect(page.waitForFunction).toHaveBeenCalled();
  });

  it('waitForAppLoad can wait for shell readiness without blocking on database startup', async () => {
    const loadStates: string[] = [];
    const page = {
      waitForLoadState: vi.fn(async (state: string) => void loadStates.push(state)),
      waitForSelector: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => ({
        dispose: vi.fn(async () => undefined),
        jsonValue: vi.fn(async () => 'connected'),
      })),
      on: vi.fn(),
    } as unknown as Page;

    await waitForAppLoad(page, { waitForDatabase: false });

    expect(page.waitForLoadState).toHaveBeenCalledWith('load', expect.any(Object));
    expect(loadStates).not.toContain('networkidle');
    expect(page.waitForSelector).toHaveBeenCalled();
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it('waitForAppLoad accepts timeout inside the options object', async () => {
    const page = {
      waitForLoadState: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => ({
        dispose: vi.fn(async () => undefined),
        jsonValue: vi.fn(async () => 'connected'),
      })),
      on: vi.fn(),
    } as unknown as Page;

    await withCiEnv(false, () =>
      waitForAppLoad(page, {
        timeoutMs: 30_000,
        waitForDatabase: false,
      })
    );

    expect(page.waitForLoadState).toHaveBeenCalledWith('load', { timeout: 30_000 });
  });

  it('enforces timeout floors for local and CI app load waits', () => {
    expect(resolveWaitForAppLoadTimeout(500, false)).toBe(20_000);
    expect(resolveWaitForAppLoadTimeout(500, true)).toBe(55_000);
    expect(resolveWaitForAppLoadTimeout(120_000, true)).toBe(120_000);
    expect(resolveNetworkIdleTimeout(false)).toBe(2000);
    expect(resolveNetworkIdleTimeout(true)).toBe(5000);
  });

  it('uses a larger local database readiness floor without widening shell readiness', () => {
    expect(resolveWaitForAppLoadTimeout(500, false)).toBe(20_000);
    expect(resolveWaitForDatabaseReadyTimeout(500, false)).toBe(45_000);
    expect(resolveWaitForDatabaseReadyTimeout(500, true)).toBe(55_000);
    expect(resolveWaitForDatabaseReadyTimeout(120_000, false)).toBe(120_000);
  });

  it('logs CI diagnostics when panel-id selector fallback is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let waitForSelectorCallCount = 0;
    const page = {
      waitForLoadState: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async (selector: string) => {
        waitForSelectorCallCount += 1;
        if (waitForSelectorCallCount === 2 && selector.includes('main-content-panel')) {
          throw new Error('selector missing');
        }
      }),
      waitForFunction: vi.fn(async () => ({
        dispose: vi.fn(async () => undefined),
        jsonValue: vi.fn(async () => 'connected'),
      })),
      evaluate: vi.fn(async () => 'mock'),
      on: vi.fn(),
    } as unknown as Page;

    try {
      await withCiEnv(true, () => waitForAppLoad(page, { timeoutMs: 10_000 }));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('main-content selector missing after readiness check')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resetLayoutState clears state and reloads', async () => {
    const evalCalls: string[] = [];
    const page = {
      evaluate: vi.fn(async (fn: () => unknown) => evalCalls.push(fn.toString())),
      reload: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      waitForSelector: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => ({
        dispose: vi.fn(async () => undefined),
        jsonValue: vi.fn(async () => 'connected'),
      })),
      // CI debug listeners (no-op in unit tests)
      on: vi.fn(),
    } as unknown as Page;
    await resetLayoutState(page);
    expect(page.reload).toHaveBeenCalled();
    expect(evalCalls.join('\n')).toContain('brainstrike.agent-sidebar-tab.v1');
    expect(evalCalls.join('\n')).toContain('panel-layout-store.v1');
    expect(evalCalls.join('\n')).toContain('context-explorer-layout-store.v1');
    expect(evalCalls.join('\n')).toContain('tools-panel.v1');
  });

  it('waitForDatabaseReady applies the local timeout floor', async () => {
    const handle = {
      dispose: vi.fn(async () => undefined),
      jsonValue: vi.fn(async () => 'connected'),
    };
    const page = {
      waitForFunction: vi.fn(async () => handle),
    } as unknown as Page;

    await withCiEnv(false, () => waitForDatabaseReady(page, 10_000));

    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), null, {
      timeout: 45_000,
    });
    expect(handle.dispose).toHaveBeenCalled();
  });

  it('waitForDatabaseReady applies the CI timeout floor', async () => {
    const handle = {
      dispose: vi.fn(async () => undefined),
      jsonValue: vi.fn(async () => 'connected'),
    };
    const page = {
      waitForFunction: vi.fn(async () => handle),
    } as unknown as Page;

    await withCiEnv(true, () => waitForDatabaseReady(page, 10_000));

    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), null, {
      timeout: 55_000,
    });
    expect(handle.dispose).toHaveBeenCalled();
  });

  it('waitForDatabaseReady waits for connected instead of failing on transient disconnected state', async () => {
    const originalDocument = globalThis.document;
    let connected = false;
    const documentMock = {
      querySelector: vi.fn((selector: string) => {
        if (selector === '[data-testid="status-bar-db-connected"]') {
          return connected ? {} : null;
        }
        if (selector === '[data-testid="status-bar-db-disconnected"]') {
          return connected ? null : {};
        }
        return null;
      }),
    };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: documentMock,
    });
    const handle = { dispose: vi.fn(async () => undefined) };
    const page = {
      waitForFunction: vi.fn(async (predicate: () => boolean) => {
        expect(predicate()).toBe(false);
        connected = true;
        expect(predicate()).toBe(true);
        return handle;
      }),
    } as unknown as Page;

    try {
      await waitForDatabaseReady(page, 10_000);
      expect(handle.dispose).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('waitForDatabaseReady fails loudly when the database remains disconnected until timeout', async () => {
    const page = {
      waitForFunction: vi.fn(async () => {
        throw new Error('timed out');
      }),
      evaluate: vi.fn(async () => ({
        dbPath: null,
        hasE2ETestHooks: false,
        state: 'disconnected',
        statusText: 'Storage: PGlite',
      })),
    } as unknown as Page;

    await expect(waitForDatabaseReady(page, 10_000)).rejects.toThrow(
      'Last observed state was disconnected'
    );
  });

  it('waitForDatabaseReady reports loading status when the app never becomes ready', async () => {
    const page = {
      waitForFunction: vi.fn(async () => {
        throw new Error('timed out');
      }),
      evaluate: vi.fn(async () => ({
        dbPath: null,
        hasE2ETestHooks: false,
        state: 'loading',
        statusText: 'Storage: Connecting...',
      })),
    } as unknown as Page;

    await expect(waitForDatabaseReady(page, 10_000)).rejects.toThrow(
      'Last observed state was loading. Status text: Storage: Connecting... E2E hooks present: no.'
    );
  });
});
