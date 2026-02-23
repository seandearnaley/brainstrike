import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { getPanelElements, resetLayoutState, waitForAppLoad } from '../layout-helpers';

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
