import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDevEnv } from '../env-utils';

describe('isDevEnv', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.env['NODE_ENV'] = undefined;
  });

  it('returns a boolean value', () => {
    const result = isDevEnv();
    expect(typeof result).toBe('boolean');
  });

  it('reflects development mode via import.meta.env.MODE', () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('MODE', 'development');
    expect(isDevEnv()).toBe(true);
  });

  it('falls back to NODE_ENV when import.meta.env is undefined', () => {
    process.env['NODE_ENV'] = 'development';
    expect(isDevEnv()).toBe(true);
  });
});
