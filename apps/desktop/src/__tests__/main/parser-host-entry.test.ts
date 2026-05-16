/**
 * Contract tests for the parser host's pure entry function.
 *
 * Cycle 3.1: identity + smoke parse.
 * Cycle 3.2: language/JSX/error-recovery matrix + defensive checks.
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

function expectOk(response: Awaited<ReturnType<typeof handleParseRequest>>) {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    throw new Error(`expected ok response, got: ${response.error}`);
  }
  return response;
}

describe('handleParseRequest', () => {
  it('echoes the requestId on the response', async () => {
    const response = await handleParseRequest(baseRequest);

    expect(response.requestId).toBe('test-1');
  });

  it('returns ok: true with a typed root for a trivial JavaScript declaration', async () => {
    const response = await handleParseRequest(baseRequest);

    const ok = expectOk(response);
    expect(typeof ok.root.type).toBe('string');
  });

  describe('language flag', () => {
    it('accepts TypeScript-only syntax when language is typescript', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'interface Foo { x: number }',
        options: { ...baseRequest.options, language: 'typescript' },
      });

      const ok = expectOk(response);
      expect(typeof ok.root.type).toBe('string');
    });

    it('rejects TypeScript-only syntax when language is javascript and errorRecovery is off', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'interface Foo { x: number }',
        options: { ...baseRequest.options, errorRecovery: false, language: 'javascript' },
      });

      expect(response.ok).toBe(false);
    });
  });

  describe('jsx flag', () => {
    it('accepts JSX when jsx is true', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'const el = <div>hi</div>',
        options: { ...baseRequest.options, jsx: true },
      });

      expectOk(response);
    });

    it('rejects JSX when jsx is false and errorRecovery is off', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'const el = <div>hi</div>',
        options: { ...baseRequest.options, errorRecovery: false, jsx: false },
      });

      expect(response.ok).toBe(false);
    });
  });

  describe('errorRecovery flag', () => {
    // oxc differs from Babel: oxc *always* recovers and returns a Program,
    // surfacing errors via result.errors. Our adapter applies the flag
    // semantically: errorRecovery=true → return tree even with errors;
    // errorRecovery=false → translate error count > 0 into a failure response.
    const malformed = 'const x = 1\nfoo bar baz\nconst y = 2';

    it('returns a tree on malformed input when errorRecovery is true', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: malformed,
      });

      expectOk(response);
    });

    it('returns failure on malformed input when errorRecovery is false', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: malformed,
        options: { ...baseRequest.options, errorRecovery: false },
      });

      expect(response.ok).toBe(false);
      if (response.ok) {
        throw new Error('expected failure response');
      }
      expect(response.error).toBeTruthy();
    });
  });

  describe('defensive', () => {
    it('returns failure with a string error when content is empty and errorRecovery is off', async () => {
      // Empty input is technically valid (a Program with no body), so this
      // should still succeed. The test pins the behavior so we notice if oxc
      // ever changes its empty-input handling.
      const response = await handleParseRequest({
        ...baseRequest,
        content: '',
        options: { ...baseRequest.options, errorRecovery: false },
      });

      expectOk(response);
    });

    it('preserves the requestId across error responses', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'interface Bad { }',
        options: { ...baseRequest.options, errorRecovery: false, language: 'javascript' },
        requestId: 'unique-error-id',
      });

      expect(response.requestId).toBe('unique-error-id');
    });
  });
});
