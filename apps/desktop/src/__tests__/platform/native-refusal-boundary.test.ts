import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import {
  type NativeIndexRefusalCause,
  NativeIndexRefusalError,
} from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalError, canonicalFault } from '../../canonical-utility-protocol';
import { HostedEmbeddingError } from '../../hosted-embedding-error';
import { settleIpcResult } from '../../platform/desktop-ipc-registry';

const log = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', () => ({ createLogger: () => ({ error: log }) }));
afterEach(() => vi.clearAllMocks());

const cases: readonly NativeIndexRefusalCause[] = [
  { kind: 'transitioning' },
  { kind: 'closed', reason: 'private-owner-reason' },
  { kind: 'setup-required', message: 'private-owner-message' },
  { kind: 'settings-invalid', message: 'private-owner-message' },
  { kind: 'source-failure', message: 'private-owner-message' },
];

it.each(cases)(
  'preserves the $kind refusal across the renderer boundary without private cause text',
  async (cause) => {
    const inner = new Error('/private/profile/index.sqlite: private-owner-message');
    const error = new NativeIndexRefusalError(cause, inner.message, { cause: inner });
    const wire = await settleIpcResult(
      { category: 'native-index', code: 'native-index-failed' },
      () => {
        throw error;
      }
    );
    expect(wire).toMatchObject({
      error: {
        category:
          cause.kind === 'setup-required' || cause.kind === 'settings-invalid'
            ? 'configuration'
            : 'availability',
        code: `native-index-${cause.kind}`,
        kind: 'refusal',
      },
      ok: false,
    });
    expect(JSON.stringify(wire)).not.toContain('private-owner');
    expect(JSON.stringify(wire)).not.toContain('/private/profile');
    let received: unknown;
    try {
      readBoundaryResult(structuredClone(wire));
    } catch (failure) {
      received = failure;
    }
    expect(received).toMatchObject({ code: error.code });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      cause: inner,
      code: error.code,
      correlationId: expect.any(String),
    });
    if (!wire.ok) {
      expect(log.mock.calls[0]?.[1]).toMatchObject({ correlationId: wire.error.correlationId });
    }
  }
);

it('carries the recorded missing-key generate/join aggregate through visible status IPC', async () => {
  const original = new HostedEmbeddingError(
    'missing-key',
    'No API key configured for the embedding provider.',
    { cause: new Error('private missing-key fixture') }
  );
  const error = canonicalError(
    canonicalFault(
      new AggregateError([original, original], 'Canonical inference and retirement failed.')
    )
  );
  const wire = await settleIpcResult(
    { category: 'native-index', code: 'index-search:status' },
    () => {
      throw error;
    }
  );
  expect(wire).toMatchObject({
    error: {
      code: 'embedding.missing-key',
      correlationId: expect.any(String),
      kind: 'refusal',
      remedy: expect.any(String),
    },
    ok: false,
  });
  expect(JSON.stringify(wire)).not.toContain('private missing-key fixture');
  expect(() => readBoundaryResult(structuredClone(wire))).toThrow(
    expect.objectContaining({ code: 'embedding.missing-key' })
  );
  expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cause: error }));
});
