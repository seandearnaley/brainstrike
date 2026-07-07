import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasExplicitAutomatedTestOptIn,
  shouldExposeAutomatedTestApis,
} from '../fixture-test-exposure';

describe('fixture-test-exposure', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: undefined,
    });
    window.__brainstrike_e2e_expose_file_explorer_store__ = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: undefined,
    });
    window.__brainstrike_e2e_expose_file_explorer_store__ = undefined;
  });

  it('requires both the window opt-in flag and webdriver in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(shouldExposeAutomatedTestApis({ DEV: false, MODE: 'production' })).toBe(false);

    window.__brainstrike_e2e_expose_file_explorer_store__ = true;
    expect(shouldExposeAutomatedTestApis({ DEV: false, MODE: 'production' })).toBe(false);

    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: true,
    });
    expect(hasExplicitAutomatedTestOptIn()).toBe(true);
    expect(shouldExposeAutomatedTestApis({ DEV: false, MODE: 'production' })).toBe(true);
  });

  it('exposes test apis in dev mode without the production opt-in', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(shouldExposeAutomatedTestApis({ DEV: true, MODE: 'development' })).toBe(true);
  });

  it('exposes test apis for desktop e2e runs', () => {
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    expect(shouldExposeAutomatedTestApis({ DEV: false, MODE: 'production' })).toBe(true);
  });
});
