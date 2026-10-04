import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconstructArtifactSearch,
  requireArtifactContinuation,
  requireArtifactPage,
  requireDiscoveredProducer,
  toolPayload,
} from './artifact-evidence.ts';

const message = (value) => ({ content: JSON.stringify(value), role: 'tool' });
const catalog = { nextOffset: null, tools: [{ name: 'm2-output_read_corpus' }], total: 1 };
const page = {
  content: 'preview',
  endByte: 7,
  format: 'text',
  next: { input: { cursor: 'server-issued-opaque-token' }, tool: 'registered_reader' },
  offsetByte: 0,
};

test('takes the exact discovered name and advertised reader input', () => {
  assert.equal(requireDiscoveredProducer(message(catalog)), 'm2-output_read_corpus');
  assert.deepEqual(requireArtifactPage(message(page)), page);
  assert.equal(requireArtifactPage(message({ ...page, format: 'json' })).format, 'json');
});

test('rejects not-found replies and incomplete or ambiguous catalogs', () => {
  for (const value of [
    { message: 'Tool not found', success: false },
    { ...catalog, nextOffset: 1 },
    { ...catalog, tools: [] },
    { ...catalog, tools: [...catalog.tools, { name: 'other' }] },
    { ...catalog, total: 2 },
  ]) {
    assert.throws(() => requireDiscoveredProducer(message(value)));
  }
});

test('rejects arbitrary nested cursors, invented reader fields and invalid preview ranges', () => {
  for (const value of [
    { error: { cursor: 'arbitrary-token' } },
    { ...page, next: { input: { cursor: 'token', mode: 'cursor' }, tool: 'reader' } },
    { ...page, next: { input: { cursor: '' }, tool: 'reader' } },
    { ...page, endByte: 8 },
    { ...page, offsetByte: 1 },
    { ...page, format: 'binary' },
    { ...page, content: 'x'.repeat(8001), endByte: 8001 },
  ]) {
    assert.throws(() => requireArtifactPage(message(value)));
  }
});

test('requires a direct JSON object tool payload instead of recursively guessing data', () => {
  assert.deepEqual(toolPayload(message({ success: true })), { success: true });
  for (const value of [null, { content: 'plain text' }, message([]), { content: [page] }]) {
    assert.throws(() => toolPayload(value));
  }
});

const next = { input: { cursor: 'actual-next-token' }, tool: 'registered_reader' };
const continuation = (content, offsetByte, tail) =>
  message({
    content,
    endByte: offsetByte + Buffer.byteLength(content),
    format: 'json',
    offsetByte,
    ...tail,
  });

test('reconstructs a searched artifact through contiguous nonzero and final UTF-8 pages', () => {
  const result = {
    artifactRef: {
      byteLength: 30_735,
      expiresAt: '2026-10-10T11:04:16.484Z',
      format: 'json',
      id: 'actual-artifact',
    },
    matches: [{ lineText: 'deep marker é' }],
    type: 'artifact_search',
  };
  const raw = JSON.stringify(result);
  const parts = [raw.slice(0, 12), raw.slice(12, 38), raw.slice(38)];
  let offset = 0;
  const pages = parts.map((content, index) => {
    const page = continuation(content, offset, index === 2 ? { complete: true } : { next });
    offset += Buffer.byteLength(content);
    return page;
  });
  assert.deepEqual(reconstructArtifactSearch(pages), result);
  assert.equal(requireArtifactContinuation(pages[1], 12).offsetByte, 12);
  assert.deepEqual(requireArtifactContinuation(pages[1], 12).next, next);
  const encoded = JSON.stringify('é\n');
  assert.equal(
    requireArtifactContinuation(
      message({
        complete: true,
        content: encoded,
        contentEncoding: 'json-string',
        endByte: 7,
        format: 'json',
        offsetByte: 4,
      }),
      4
    ).content,
    'é\n'
  );
});

test('rejects gaps, overlaps, nonprogress, ambiguous completion and search flags in paging', () => {
  const valid = { content: 'page', endByte: 11, format: 'json', next, offsetByte: 7 };
  for (const invalid of [
    { ...valid, offsetByte: 6 },
    { ...valid, offsetByte: 8 },
    { ...valid, endByte: 7 },
    { ...valid, endByte: 12 },
    { ...valid, endByte: 11.5 },
    { ...valid, complete: true },
    { ...valid, next: undefined },
    { ...valid, contentEncoding: 'base64' },
    { ...valid, next: { ...next, input: { cursor: 'token', pattern: 'marker' } } },
  ]) {
    assert.throws(() => requireArtifactContinuation(message(invalid), 7));
  }
  assert.throws(() => reconstructArtifactSearch([continuation('{}', 0, { next })]));
  assert.throws(() =>
    reconstructArtifactSearch([
      continuation('{}', 0, { complete: true }),
      continuation('{}', 2, { complete: true }),
    ])
  );
});

test('rejects invalid public artifact identity and expiry after complete reconstruction', () => {
  const artifactRef = {
    byteLength: 30_735,
    expiresAt: '2026-10-10T11:04:16.484Z',
    format: 'json',
    id: 'actual-artifact',
  };
  for (const invalid of [
    undefined,
    { ...artifactRef, id: '' },
    { ...artifactRef, expiresAt: 'not-a-date' },
    { ...artifactRef, byteLength: -1 },
  ]) {
    const raw = JSON.stringify({ artifactRef: invalid, type: 'artifact_search' });
    assert.throws(() => reconstructArtifactSearch([continuation(raw, 0, { complete: true })]));
  }
});
