/**
 * Contract tests for the Babel parser adapter.
 *
 * Cycle 2.1: identity + smoke parse.
 * Cycle 2.2: language/JSX/error-recovery matrix, including negative tests
 * that prove flags actually gate behavior.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 2)
 */

import { describe, expect, it } from 'vitest';
import { babelAdapter } from '../parsers/babel-adapter';

const baseOptions = {
  errorRecovery: true,
  jsx: false,
  language: 'javascript',
} as const;

describe('babelAdapter', () => {
  it('identifies itself as the babel adapter', () => {
    expect(babelAdapter.id).toBe('babel');
  });

  it('parses a trivial JavaScript declaration into a File-rooted tree', async () => {
    const content = 'const x = 1';

    const root = await babelAdapter.parse(content, baseOptions);

    // Babel returns a File node at the root with start=0 and end matching content length.
    // We assert only what the chunking consumer actually depends on: a typed root with spans.
    expect(root.type).toBe('File');
    expect(root.start).toBe(0);
    expect(root.end).toBe(content.length);
  });

  describe('language flag', () => {
    it('accepts TypeScript-only syntax when language is typescript', async () => {
      const content = 'interface Foo { x: number }';

      const root = await babelAdapter.parse(content, { ...baseOptions, language: 'typescript' });

      expect(root.type).toBe('File');
    });

    it('rejects TypeScript-only syntax when language is javascript', async () => {
      const content = 'interface Foo { x: number }';

      // Flip errorRecovery off so syntax errors throw instead of being swallowed —
      // this is the only way to *prove* the language flag gates the typescript plugin.
      await expect(
        babelAdapter.parse(content, {
          ...baseOptions,
          language: 'javascript',
          errorRecovery: false,
        })
      ).rejects.toThrow();
    });
  });

  describe('jsx flag', () => {
    it('accepts JSX syntax when jsx is true', async () => {
      const content = 'const el = <div>hi</div>';

      const root = await babelAdapter.parse(content, { ...baseOptions, jsx: true });

      expect(root.type).toBe('File');
    });

    it('rejects JSX syntax when jsx is false', async () => {
      const content = 'const el = <div>hi</div>';

      await expect(
        babelAdapter.parse(content, { ...baseOptions, jsx: false, errorRecovery: false })
      ).rejects.toThrow();
    });
  });

  describe('errorRecovery flag', () => {
    // Babel's error recovery is anchor-based: it can only resume parsing if it can
    // skip forward to a statement boundary. Garbage *between* valid statements is
    // recoverable; incomplete expressions at EOF or after `=` are not. We use the
    // recoverable shape here so the test asserts what Babel can actually deliver.
    const recoverableMalformed = 'const x = 1\nfoo bar baz\nconst y = 2';

    it('returns a best-effort tree on recoverable malformed input when errorRecovery is true', async () => {
      const root = await babelAdapter.parse(recoverableMalformed, {
        ...baseOptions,
        errorRecovery: true,
      });

      expect(root.type).toBe('File');
    });

    it('throws on the same malformed input when errorRecovery is false', async () => {
      await expect(
        babelAdapter.parse(recoverableMalformed, { ...baseOptions, errorRecovery: false })
      ).rejects.toThrow();
    });
  });
});
