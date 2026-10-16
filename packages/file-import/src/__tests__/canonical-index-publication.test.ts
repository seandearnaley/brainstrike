// @vitest-environment node
import { readFile } from 'node:fs/promises';
import type { ChunkResult } from '@brainstrike/chunking-worker';
import { describe, expect, it } from 'vitest';
import type { CanonicalChunkEvent } from '../canonical-chunk-producer';
import { canonicalIndexPayload, canonicalIndexPublication } from '../canonical-index-publication';

const capture = JSON.parse(
  await readFile(
    new URL(import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')),
    'utf8'
  )
) as { content: string; fileId: string; relativePath: string; result: ChunkResult };
const source = {
  content: capture.content,
  fileName: 'artifact-reader-model-projection.ts',
  filePath: capture.relativePath,
  fileRecordId: capture.fileId,
};
const event: CanonicalChunkEvent = { kind: 'worker-result', result: capture.result, source };

describe('canonical index publication', () => {
  it('preserves recorded source, chunk objects and graph identities without another parse', () => {
    const payload = canonicalIndexPayload(event);
    expect(payload.content).toBe(capture.content);
    expect(payload.fileId).toBe(capture.fileId);
    expect(payload.providedChunks).toBe(capture.result.chunks);
    expect(payload.syntax?.symbols).toHaveLength(1);
    expect(payload.syntax?.symbols[0]).toMatchObject({
      fileRecordId: capture.fileId,
      name: 'createArtifactReaderModelProjection',
      seq: 0,
      startOffset: 203,
    });
    expect(payload.syntax?.refs).toHaveLength(3);
    expect(payload.syntax?.refs[1]).toEqual({
      fileRecordId: capture.fileId,
      fromSymbolSeq: 0,
      kind: 'call',
      line: 8,
      name: 'projectToolOutputArtifactPage',
      seq: 1,
    });
  });

  it('keeps rootless payloads free of fabricated scope and adds only supplied workspace scope', () => {
    const payload = canonicalIndexPayload(event);
    expect(payload).not.toHaveProperty('rootId');
    expect(payload).not.toHaveProperty('relativePath');
    const scope = { relativePath: capture.relativePath, rootId: 'authorized-root' };
    expect(canonicalIndexPublication(event, scope)).toEqual({ ...payload, ...scope });
  });

  it('publishes actual empty content without chunks or invented syntax', () => {
    expect(
      canonicalIndexPayload({ kind: 'empty-source', source: { ...source, content: '' } })
    ).toEqual({
      content: '',
      fileId: capture.fileId,
      providedChunks: [],
    });
  });

  it.each([
    { name: 'foreign result identity', patch: { fileRecordId: 'foreign' }, reason: 'identity' },
    { name: 'skipped nonempty source', patch: { skipped: true }, reason: 'skipped' },
    {
      name: 'incomplete source ranges',
      patch: { sourceRangeSkippedChunks: 1 },
      reason: 'incomplete',
    },
  ])('refuses $name', ({ patch, reason }) => {
    expect(() =>
      canonicalIndexPayload({
        kind: 'worker-result',
        result: { ...capture.result, ...patch },
        source,
      })
    ).toThrow(reason);
  });

  it('refuses an empty event carrying nonempty original content', () => {
    expect(() => canonicalIndexPayload({ kind: 'empty-source', source })).toThrow('nonempty');
  });

  it('refuses graph references to absent symbols', () => {
    expect(() =>
      canonicalIndexPayload({
        kind: 'worker-result',
        result: {
          ...capture.result,
          symbolRefs: [{ enclosingSymbolIndex: 1, kind: 'call', line: 8, name: 'foreign' }],
        },
        source,
      })
    ).toThrow('enclosing symbol index');
  });
});
