/**
 * Phase 2 Cycle 2.1 — first contract test for the Babel parser adapter.
 *
 * This is the smallest possible test that proves the adapter contract works.
 * Subsequent cycles add TS/JSX/error-recovery coverage (Cycle 2.2).
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 2)
 */

import { describe, expect, it } from 'vitest';
import { babelAdapter } from '../parsers/babel-adapter';

describe('babelAdapter', () => {
  it('identifies itself as the babel adapter', () => {
    expect(babelAdapter.id).toBe('babel');
  });

  it('parses a trivial JavaScript declaration into a File-rooted tree', async () => {
    const content = 'const x = 1';

    const root = await babelAdapter.parse(content, {
      language: 'javascript',
      jsx: false,
      errorRecovery: true,
    });

    // Babel returns a File node at the root with start=0 and end matching content length.
    // We assert only what the chunking consumer actually depends on: a typed root with spans.
    expect(root.type).toBe('File');
    expect(root.start).toBe(0);
    expect(root.end).toBe(content.length);
  });
});
