import { afterEach, expect, it, vi } from 'vitest';
import { createDocumentCloseProof } from '../document-close-proof';

afterEach(() => vi.restoreAllMocks());

it('admits only opted-in metadata and bounds its proof output', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {});
  createDocumentCloseProof(false, 'renderer')('renderer-prepare-begin');
  expect(output).not.toHaveBeenCalled();

  const observe = createDocumentCloseProof(true, 'renderer');
  observe('renderer-prepare-begin');
  const record = JSON.parse(
    String(output.mock.calls[0]?.[0]).slice('[document-close-proof] '.length)
  );
  expect(record).toEqual({
    at: expect.any(Number),
    monotonicMs: expect.any(Number),
    phase: 'renderer-prepare-begin',
    realm: 'renderer',
    sequence: 1,
    timeOrigin: expect.any(Number),
  });
  for (let index = 0; index < 600; index += 1) {
    observe('renderer-prepare-end');
  }
  expect(output).toHaveBeenCalledTimes(513);
  expect(String(output.mock.calls.at(-1)?.[0])).toContain('"phase":"truncated"');
});
