/**
 * Contract tests for the parser adapter selection facade.
 *
 * Phase 2 Cycle 2.3: identity + smoke parse (Babel baseline).
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 5)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectAdapter } from '../parsers/select-adapter';
import type { ParserAdapter } from '../parsers/types';

/**
 * Phase 9 strict-mode helper: most tests in this file assert that
 * selectAdapter returns a SPECIFIC non-null adapter. With the new
 * `ParserAdapter | null` return type, we need to narrow null away before
 * accessing `.id`. This helper makes that intent explicit (test would
 * fail with a clear message if selectAdapter unexpectedly returned null).
 */
function expectAdapter(adapter: ParserAdapter | null): ParserAdapter {
  expect(adapter).not.toBeNull();
  return adapter as ParserAdapter;
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
    setTreeSitterLanguages(undefined);
  });
  afterEach(() => {
    setTreeSitterLanguages(undefined);
  });

  it('returns babel when no filename is given', () => {
    const adapter = expectAdapter(selectAdapter());

    expect(adapter.id).toBe('babel');
  });

  it('returns an adapter whose parse function works end-to-end', async () => {
    // Smoke test: prove the facade actually returns a usable adapter.
    const adapter = expectAdapter(selectAdapter());

    const root = await adapter.parse('const x = 1', {
      errorRecovery: true,
      jsx: false,
      language: 'javascript',
    });

    expect(root.type).toBe('File');
  });

  describe('filename-aware routing (Phase 5 of tree-sitter PRD #998)', () => {
    // Backward compat: zero-arg selectAdapter() preserves existing behavior.
    // Filename-aware routing only changes the behavior when a filename is
    // supplied AND the file has a tree-sitter-supported extension.

    it('returns babel for .ts files', () => {
      expect(expectAdapter(selectAdapter('Component.tsx')).id).toBe('babel');
      expect(expectAdapter(selectAdapter('utils.ts')).id).toBe('babel');
    });

    it('returns tree-sitter for .py files when python is enabled', () => {
      setTreeSitterLanguages(['python']);

      const adapter = expectAdapter(selectAdapter('script.py'));
      expect(adapter.id).toBe('tree-sitter');
    });

    it('returns tree-sitter for .pyi stub files when python is enabled', () => {
      setTreeSitterLanguages(['python']);

      expect(expectAdapter(selectAdapter('module.pyi')).id).toBe('tree-sitter');
    });

    it('returns NULL for .py files when python is NOT enabled (Phase 9 strict)', () => {
      // Per strictness: don't return the wrong adapter (babel can't parse
      // Python). Return null and force the caller to handle "no AST help"
      // explicitly. The previous "fall through to babel" behavior was a
      // silent contract violation — babel parsing Python would fail at
      // call time with a confusing error.
      setTreeSitterLanguages(undefined);
      expect(selectAdapter('script.py')).toBeNull();
    });

    it('returns NULL when language list is set but does not include python (Phase 9 strict)', () => {
      setTreeSitterLanguages([]);
      expect(selectAdapter('script.py')).toBeNull();
    });

    it('is case-insensitive on file extensions', () => {
      setTreeSitterLanguages(['python']);

      expect(expectAdapter(selectAdapter('SCRIPT.PY')).id).toBe('tree-sitter');
      expect(expectAdapter(selectAdapter('Module.PyI')).id).toBe('tree-sitter');
    });

    it('ignores tree-sitter routing for non-Python extensions even when python is enabled', () => {
      // Enabling python doesn't accidentally route .ts/.js elsewhere.
      setTreeSitterLanguages(['python']);

      expect(expectAdapter(selectAdapter('Component.tsx')).id).toBe('babel');
      expect(expectAdapter(selectAdapter('utils.js')).id).toBe('babel');
    });
  });
});
