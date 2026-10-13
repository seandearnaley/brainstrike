import { INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { resolveProviderError } from '../mastra-chunk-decoding';

describe('typed provider failure evidence', () => {
  it('never exposes an untyped local exception as provider evidence', () => {
    const result = resolveProviderError(new Error('ENOENT /Users/fixture/private.ts'), undefined);
    expect(result.detail).toBe(INTERNAL_FAULT.message);
    expect(result.failure).toEqual(INTERNAL_FAULT);
  });

  it('carries deliberately bounded, secret-redacted evidence on a rejected credential', () => {
    const key = `sk-${'x'.repeat(32)}`;
    const result = resolveProviderError(
      { message: `User not found. ${key} ${'detail '.repeat(150)}`, statusCode: 401 },
      undefined
    );
    expect(result.failure).toMatchObject({
      category: 'authorization',
      code: 'provider.credential-rejected',
      kind: 'refusal',
    });
    expect(result.failure.providerEvidence).toContain('[redacted-secret:api-key]');
    expect(result.failure.providerEvidence?.length).toBeLessThanOrEqual(600);
    expect(result.detail).not.toContain(key);
    expect(result.detail).toContain('User not found.');
  });
});
