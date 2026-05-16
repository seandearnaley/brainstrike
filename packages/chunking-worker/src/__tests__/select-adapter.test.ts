/**
 * Contract tests for the parser adapter selection facade.
 *
 * Cycle 2.3 (this commit): trivial baseline — selectAdapter() returns the
 * Babel adapter in the current single-environment world. The test exists to
 * pin the seam in place; future phases (5) will expand it into a routing
 * matrix (browser vs electron-chunking-host × flag on/off × adapter health).
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 2)
 */

import { describe, expect, it } from 'vitest';
import { selectAdapter } from '../parsers/select-adapter';

describe('selectAdapter', () => {
  it('returns the babel adapter today (only adapter wired)', () => {
    const adapter = selectAdapter();

    expect(adapter.id).toBe('babel');
  });

  it('returns an adapter whose parse function works end-to-end', async () => {
    // Smoke test: prove the facade actually returns a usable adapter,
    // not just a tagged sentinel. Catches the case where selectAdapter
    // hands back something that satisfies the type but breaks at runtime.
    const adapter = selectAdapter();

    const root = await adapter.parse('const x = 1', {
      errorRecovery: true,
      jsx: false,
      language: 'javascript',
    });

    expect(root.type).toBe('File');
  });
});
