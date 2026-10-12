// @vitest-environment node
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { expect, it } from 'vitest';
import { receiptSchema } from '../canonical-utility-protocol';

it('preserves per-file unsupported-content exclusions through utility receipt decoding', () => {
  const receipt = {
    excluded: [
      { fileId: null, reason: 'null-byte-content', relativePath: 'notes.md', rootId: 'root' },
    ],
    reason: 'complete',
    scanComplete: true,
    ticket: {
      generation: 1,
      requestId: 'scan',
      scope: { kind: 'workspace', rootId: 'root' },
      storeId: 'store',
    },
  };
  expect(makeThrowingDecoder(receiptSchema)(receipt)).toEqual(receipt);
  expect(() =>
    makeThrowingDecoder(receiptSchema)({
      ...receipt,
      excluded: [{ ...receipt.excluded[0], reason: 'permission-denied' }],
    })
  ).toThrow();
});
