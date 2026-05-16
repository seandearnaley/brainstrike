/**
 * Phase 3 Cycle 3.1 — first contract test for the parser host's pure entry function.
 *
 * Tests `handleParseRequest()` directly (no child-process spawn, no parentPort
 * mocking). Mirrors the unit-testable approach used by `db-host-entry.test.ts`,
 * which similarly separates pure logic from IPC plumbing.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 3)
 */

import { describe, expect, it } from 'vitest';
import { handleParseRequest } from '../../parser-host-entry';
import type { ParserHostParseRequest } from '../../parser-host-shared';

const baseRequest: ParserHostParseRequest = {
  content: 'const x = 1',
  options: {
    errorRecovery: true,
    jsx: false,
    language: 'javascript',
  },
  requestId: 'test-1',
};

describe('handleParseRequest', () => {
  it('echoes the requestId on the response', async () => {
    const response = await handleParseRequest(baseRequest);

    expect(response.requestId).toBe('test-1');
  });

  it('returns ok: true with a typed root for a trivial JavaScript declaration', async () => {
    const response = await handleParseRequest(baseRequest);

    expect(response.ok).toBe(true);
    if (!response.ok) {
      // narrowing — if the assertion above failed we'd already be in the failure branch
      throw new Error(`expected ok response, got: ${response.error}`);
    }
    expect(typeof response.root.type).toBe('string');
  });
});
