/**
 * Contract tests for the parser adapter selection facade.
 *
 * Phase 2 Cycle 2.3: identity + smoke parse (browser baseline).
 * Phase 5 Cycle 5.1: routing matrix across environment × flag.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 5)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectAdapter } from '../parsers/select-adapter';

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

function setTreeSitterLanguages(languages: readonly 'python'[] | undefined): void {
  if (languages === undefined) {
    globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = undefined;
    return;
  }
  globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = [...languages];
}

describe('selectAdapter', () => {
  beforeEach(() => {
    setEnv(undefined);
    setFlag(undefined);
    setTreeSitterLanguages(undefined);
  });
  afterEach(() => {
    setEnv(undefined);
    setFlag(undefined);
    setTreeSitterLanguages(undefined);
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

  describe('filename-aware routing (Phase 5 of tree-sitter PRD #998)', () => {
    // Backward compat: zero-arg selectAdapter() preserves existing behavior.
    // Filename-aware routing only changes the behavior when a filename is
    // supplied AND the file has a tree-sitter-supported extension.

    it('returns babel for .ts files when no env/flag set (preserves browser default)', () => {
      expect(selectAdapter('Component.tsx').id).toBe('babel');
      expect(selectAdapter('utils.ts').id).toBe('babel');
    });

    it('returns oxc-native for .ts files in chunking-host env', () => {
      setEnv('electron-chunking-host');
      setFlag('auto');

      expect(selectAdapter('Component.tsx').id).toBe('oxc-native');
    });

    it('returns tree-sitter for .py files when python is enabled', () => {
      setTreeSitterLanguages(['python']);

      const adapter = selectAdapter('script.py');
      expect(adapter.id).toBe('tree-sitter');
    });

    it('returns tree-sitter for .pyi stub files when python is enabled', () => {
      setTreeSitterLanguages(['python']);

      expect(selectAdapter('module.pyi').id).toBe('tree-sitter');
    });

    it('falls back to the JS/TS default adapter for .py files when python is NOT enabled (default-off rollout)', () => {
      // Per PRD §8 "Aggressive (same as oxc)": Phases 2-7 land disabled
      // by default. Until Phase 8 flips the flag default, .py files
      // route to the same place .ts/.js would — which then degrades to
      // the recursive splitter at the caller because Python source is
      // not valid JS/TS. This is by design: the routing infrastructure
      // is in place; the operator opts in via the flag.
      setTreeSitterLanguages(undefined);

      // selectAdapter doesn't itself return null for .py — that decision
      // is the caller's, which only invokes selectAdapter for supportsAst
      // files. The caller's supportsAst check is gated by the same flag.
      // What we assert HERE: when the flag is off, selectAdapter doesn't
      // route to tree-sitter for .py.
      const adapter = selectAdapter('script.py');
      expect(adapter.id).not.toBe('tree-sitter');
    });

    it('falls back to JS/TS adapter when language list is set but does not include python', () => {
      setTreeSitterLanguages([]);

      expect(selectAdapter('script.py').id).not.toBe('tree-sitter');
    });

    it('is case-insensitive on file extensions', () => {
      setTreeSitterLanguages(['python']);

      expect(selectAdapter('SCRIPT.PY').id).toBe('tree-sitter');
      expect(selectAdapter('Module.PyI').id).toBe('tree-sitter');
    });

    it('ignores tree-sitter routing for non-Python extensions even when python is enabled', () => {
      // Enabling python doesn't accidentally route .ts/.js elsewhere.
      setTreeSitterLanguages(['python']);

      expect(selectAdapter('Component.tsx').id).toBe('babel');
      expect(selectAdapter('utils.js').id).toBe('babel');
    });
  });
});
