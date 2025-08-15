import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isFileExplorerV2Enabled, isFileExplorerV2WorkerEnabled } from '../feature-flags';

describe('feature flags precedence', () => {
  const origEnv = { ...process.env };
  const origLocation = globalThis.location;

  beforeEach(() => {
    vi.resetModules();
    for (const k of Object.keys(process.env))
      delete (process.env as Record<string, string | undefined>)[k];
    Object.assign(process.env, {});
    // Simulate non-browser context by undefining window/location via assignment to undefined
    (globalThis as unknown as { window?: unknown }).window = undefined;
    (globalThis as unknown as { location?: unknown }).location = undefined;
  });

  afterEach(() => {
    Object.assign(process.env, origEnv);
    // @ts-expect-error restore
    globalThis.location = origLocation;
  });

  it('env falls back to process.env when import.meta.env is missing', () => {
    process.env.VITE_FILE_EXPLORER_V2 = '1';
    process.env.VITE_FILE_EXPLORER_V2_WORKER = '1';
    expect(isFileExplorerV2Enabled()).toBe(true);
    expect(isFileExplorerV2WorkerEnabled()).toBe(true);
  });

  it('URL param beats localStorage and env', () => {
    // Simulate no localStorage in this environment
    // Provide URL params via desktop env string
    process.env.BRAINSTRIKE_URL_PARAMS = 'ff_explorer_v2=0&ff_explorer_v2_worker=0';
    process.env.VITE_FILE_EXPLORER_V2 = '1';
    process.env.VITE_FILE_EXPLORER_V2_WORKER = '1';
    expect(isFileExplorerV2Enabled()).toBe(false);
    expect(isFileExplorerV2WorkerEnabled()).toBe(false);
  });
});
