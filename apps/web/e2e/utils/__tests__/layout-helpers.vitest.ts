import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  getPanelElements,
  resetLayoutState,
  resolveNetworkIdleTimeout,
  resolveWaitForAppLoadTimeout,
  waitForAppLoad,
} from '../layout-helpers';

describe('layout-helpers (unit)', () => {
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
    expect(els.hideExplorerButton).toBeDefined();
    expect(els.showRightPanelShim).toBeDefined();
    // Shape checks are sufficient; underlying calls are exercised by construction
  });

  it('waitForAppLoad waits for key selectors', async () => {
    const waited: string[] = [];
    const loadStates: string[] = [];
    const page = {
      waitForLoadState: vi.fn(async (state: string) => void loadStates.push(state)),
      waitForSelector: vi.fn(async (sel: string) => void waited.push(sel)),
      // CI debug listeners (no-op in unit tests)
      on: vi.fn(),
    } as unknown as Page;
    await waitForAppLoad(page, 10_000);
    // Using 'load' instead of 'domcontentloaded' to ensure JS bundles are loaded
    // before checking React elements (important for CI with vite preview)
    expect(loadStates).toContain('load');
    // Best-effort networkidle wait for deferred script loading
    expect(loadStates).toContain('networkidle');
    // Readiness check now supports both id and data-panel-id based panel markers.
    expect(waited.some((selector) => selector.includes('#middle-panel'))).toBe(true);
    expect(waited.some((selector) => selector.includes('#main-content-panel'))).toBe(true);
  });

  it('enforces timeout floors for local and CI app load waits', () => {
    expect(resolveWaitForAppLoadTimeout(500, false)).toBe(20_000);
    expect(resolveWaitForAppLoadTimeout(500, true)).toBe(55_000);
    expect(resolveWaitForAppLoadTimeout(120_000, true)).toBe(120_000);
    expect(resolveNetworkIdleTimeout(false)).toBe(2000);
    expect(resolveNetworkIdleTimeout(true)).toBe(5000);
  });

  it('logs CI diagnostics when panel-id selector fallback is missing', async () => {
    const originalCI = process.env['CI'];
    const hadCI = Object.hasOwn(process.env, 'CI');
    process.env['CI'] = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const page = {
      waitForLoadState: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async (selector: string) => {
        if (selector.startsWith('#main-content-panel')) {
          throw new Error('selector missing');
        }
      }),
      on: vi.fn(),
    } as unknown as Page;

    try {
      await waitForAppLoad(page, 10_000);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('main-content selector missing after readiness check')
      );
    } finally {
      if (hadCI) {
        process.env['CI'] = originalCI;
      } else {
        Reflect.deleteProperty(process.env, 'CI');
      }
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
      // CI debug listeners (no-op in unit tests)
      on: vi.fn(),
    } as unknown as Page;
    await resetLayoutState(page);
    expect(page.reload).toHaveBeenCalled();
    expect(evalCalls.join('\n')).toContain('panel-layout-store.v1');
  });
});
