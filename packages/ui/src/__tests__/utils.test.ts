import { afterEach, describe, expect, it } from 'vitest';
import { cn, isDevEnv } from '../lib/utils';

interface MutableImportMeta {
  env:
    | {
        MODE?: string;
      }
    | undefined;
}

// Save original environment values to restore after each test
const originalImportMetaEnv = (import.meta as MutableImportMeta).env;
const NODE_ENV_KEY = 'NODE_ENV';
const originalNodeEnv = process.env[NODE_ENV_KEY];

afterEach(() => {
  (import.meta as MutableImportMeta).env = originalImportMetaEnv;
  process.env[NODE_ENV_KEY] = originalNodeEnv;
});

describe('cn', () => {
  it('merges simple class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes and merges duplicates', () => {
    expect(cn('p-2', 'p-4', { active: true, hidden: false })).toBe('p-4 active');
  });
});

describe('isDevEnv', () => {
  it('returns true when NODE_ENV is development', () => {
    (import.meta as MutableImportMeta).env = { MODE: 'production' };
    process.env[NODE_ENV_KEY] = 'development';
    expect(isDevEnv()).toBe(true);
  });
  it('uses NODE_ENV when import.meta.env is undefined', () => {
    (import.meta as MutableImportMeta).env = undefined;
    process.env[NODE_ENV_KEY] = 'development';
    expect(isDevEnv()).toBe(true);
  });

  it('returns false when both env vars are not development', () => {
    (import.meta as MutableImportMeta).env = { MODE: 'production' };
    process.env[NODE_ENV_KEY] = 'production';
    expect(isDevEnv()).toBe(false);
  });
});
