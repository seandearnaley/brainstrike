import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveWebDbPath, resolveWebDbRuntimeSelection } from '../db-runtime';

describe('resolveWebDbRuntimeSelection', () => {
  test('defaults to the Turso browser WASM runtime when the env var is unset (A7 cutover)', () => {
    expect(resolveWebDbRuntimeSelection(undefined)).toEqual({
      bootstrapRuntime: {
        engine: 'turso',
        host: 'browser',
        persistence: 'opfs',
      },
      engine: 'turso',
      platform: 'web',
      source: 'default',
    });
  });

  test('treats a blank env value as unset (default Turso)', () => {
    expect(resolveWebDbRuntimeSelection('   ').engine).toBe('turso');
    expect(resolveWebDbRuntimeSelection('   ').source).toBe('default');
  });

  test('factory-reset default coherence: resolution is a pure function of the env, so a reset boot with runtime unset bootstraps fresh browser Turso', () => {
    // Boot-time resolution reads no persisted state (sessionStorage,
    // localStorage, IndexedDB, OPFS). Seed stale PGlite-era leftovers and
    // prove they cannot pin the next boot back to PGlite.
    window.sessionStorage.setItem('brainstrike.e2e.dbPath.v1', 'idb://web-e2e-stale');
    window.localStorage.setItem('brainstrike.runtime.legacy', 'pglite');
    try {
      const selection = resolveWebDbRuntimeSelection(undefined);
      expect(selection.engine).toBe('turso');
      expect(selection.bootstrapRuntime).toEqual({
        engine: 'turso',
        host: 'browser',
        persistence: 'opfs',
      });
    } finally {
      window.sessionStorage.clear();
      window.localStorage.clear();
    }
  });

  test('honors the explicit PGlite opt-out via VITE_BRAINSTRIKE_DB_RUNTIME=pglite', () => {
    expect(resolveWebDbRuntimeSelection('pglite')).toEqual({
      bootstrapRuntime: {
        engine: 'pglite',
        host: 'worker',
        persistence: 'idb',
      },
      engine: 'pglite',
      platform: 'web',
      source: 'env',
    });
  });

  test('accepts an explicit turso value with env provenance', () => {
    const selection = resolveWebDbRuntimeSelection('turso');
    expect(selection.engine).toBe('turso');
    expect(selection.source).toBe('env');
  });

  test('throws on a malformed env value instead of silently coercing', () => {
    expect(() => resolveWebDbRuntimeSelection('sqlite')).toThrow(
      'Unsupported Brainstrike DB runtime: sqlite'
    );
    expect(() => resolveWebDbRuntimeSelection('PGLITE')).toThrow(
      'Unsupported Brainstrike DB runtime: PGLITE'
    );
  });
});

describe('resolveWebDbPath', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  test('uses the default OPFS Turso store outside Playwright automation', () => {
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(false);
    expect(resolveWebDbPath('turso')).toBe('brainstrike-web-turso.db');
  });

  test('uses the engine-versioned PGlite IndexedDB directory for the opt-out', () => {
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(false);
    expect(resolveWebDbPath('pglite')).toBe('idb://web-pg18');
  });

  test('mints an isolated per-session OPFS store name for Turso under Playwright', () => {
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(true);
    vi.spyOn(window.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');

    const dbPath = resolveWebDbPath('turso');
    expect(dbPath).toBe('web-e2e-turso-00000000-0000-4000-8000-000000000001.db');
    expect(window.sessionStorage.getItem('brainstrike.e2e.dbPath.v1')).toBe(dbPath);

    // Reuses the stored path within the same session.
    vi.spyOn(window.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000002');
    expect(resolveWebDbPath('turso')).toBe(dbPath);
  });

  test('mints an isolated per-session idb path for the PGlite opt-out under Playwright', () => {
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(true);
    vi.spyOn(window.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000003');

    const dbPath = resolveWebDbPath('pglite');
    expect(dbPath).toBe('idb://web-e2e-00000000-0000-4000-8000-000000000003');
    expect(window.sessionStorage.getItem('brainstrike.e2e.dbPath.v1')).toBe(dbPath);
  });

  test('discards a stored e2e path from the other engine instead of reusing it', () => {
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(true);
    vi.spyOn(window.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000004');
    window.sessionStorage.setItem('brainstrike.e2e.dbPath.v1', 'idb://web-e2e-stale-pglite');

    const dbPath = resolveWebDbPath('turso');
    expect(dbPath).toBe('web-e2e-turso-00000000-0000-4000-8000-000000000004.db');
    expect(window.sessionStorage.getItem('brainstrike.e2e.dbPath.v1')).toBe(dbPath);
  });

  test('throws when Playwright isolation lacks crypto.randomUUID', () => {
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(true);
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(window, 'crypto');
    Object.defineProperty(window, 'crypto', { configurable: true, value: {} });
    try {
      expect(() => resolveWebDbPath('turso')).toThrow(
        'Playwright web E2E database isolation requires crypto.randomUUID'
      );
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(window, 'crypto', cryptoDescriptor);
      }
    }
  });
});
