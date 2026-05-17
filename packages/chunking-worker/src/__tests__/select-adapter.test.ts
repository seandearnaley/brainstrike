/**
 * Contract tests for the parser adapter selection facade.
 *
 * Phase 2 Cycle 2.3: identity + smoke parse (browser baseline).
 * Phase 5 Cycle 5.1: routing matrix across environment × flag.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 5)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetSelectAdapterCacheForTesting, selectAdapter } from '../parsers/select-adapter';

function setEnv(env: 'browser' | 'electron-chunking-host' | undefined): void {
  if (env === undefined) {
    globalThis.__BRAINSTRIKE_PARSER_ENV__ = undefined;
    return;
  }
  globalThis.__BRAINSTRIKE_PARSER_ENV__ = env;
}

function setFlag(flag: 'auto' | 'babel' | 'oxc' | undefined): void {
  if (flag === undefined) {
    globalThis.__BRAINSTRIKE_PARSER_FLAG__ = undefined;
    return;
  }
  globalThis.__BRAINSTRIKE_PARSER_FLAG__ = flag;
}

describe('selectAdapter', () => {
  beforeEach(() => {
    setEnv(undefined);
    setFlag(undefined);
    __resetSelectAdapterCacheForTesting();
  });
  afterEach(() => {
    setEnv(undefined);
    setFlag(undefined);
    __resetSelectAdapterCacheForTesting();
  });

  it('defaults to babel when no env/flag globals are set (browser-like)', () => {
    const adapter = selectAdapter();

    expect(adapter.id).toBe('babel');
  });

  it('returns an adapter whose parse function works end-to-end', async () => {
    // Smoke test: prove the facade actually returns a usable adapter.
    const adapter = selectAdapter();

    const root = await adapter.parse('const x = 1', {
      errorRecovery: true,
      jsx: false,
      language: 'javascript',
    });

    expect(root.type).toBe('File');
  });

  describe('routing matrix', () => {
    it('returns babel when env is browser, regardless of flag', () => {
      setEnv('browser');
      setFlag('oxc');

      expect(selectAdapter().id).toBe('babel');
    });

    it('returns oxc-native when env is electron-chunking-host and flag is auto', () => {
      setEnv('electron-chunking-host');
      setFlag('auto');

      const adapter = selectAdapter();
      expect(adapter.id).toBe('oxc-native');
    });

    it('returns oxc-native when env is electron-chunking-host and flag is oxc', () => {
      setEnv('electron-chunking-host');
      setFlag('oxc');

      expect(selectAdapter().id).toBe('oxc-native');
    });

    it('honors the babel kill switch even in electron-chunking-host', () => {
      setEnv('electron-chunking-host');
      setFlag('babel');

      expect(selectAdapter().id).toBe('babel');
    });

    it('treats unknown (non-undefined) flag values as the babel kill switch (rollout safety)', () => {
      // Updated for rollout-safety nit on #991: a set-but-unrecognized
      // flag value (e.g., `?parserFlag=foo`) indicates the operator
      // intended *something*, but we can't tell what. The safest
      // interpretation is the known-good path (babel) rather than
      // assuming they meant 'auto' (which routes to oxc in Electron).
      setEnv('electron-chunking-host');
      // @ts-expect-error — testing invalid flag value
      globalThis.__BRAINSTRIKE_PARSER_FLAG__ = 'something-else';

      expect(selectAdapter().id).toBe('babel');
    });
  });
});
