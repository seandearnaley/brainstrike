// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const script = `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';
assert.equal(globalThis.window, undefined);
assert.equal(globalThis.self, undefined);
const capture = JSON.parse(await readFile('../indexer/__tests__/fixtures/canonical-provided-chunks.json', 'utf8'));
const payload = canonicalIndexPayload({
  kind: 'worker-result', result: capture.result,
  source: { content: capture.content, fileRecordId: capture.fileId, fileName: 'artifact-reader-model-projection.ts', filePath: capture.relativePath }
});
assert.equal(payload.content, capture.content);
assert.equal(payload.fileId, capture.fileId);
assert.deepEqual(payload.providedChunks, capture.result.chunks);
assert.equal(payload.syntax.symbols.length, 1);
assert.equal(payload.syntax.refs[1].fromSymbolSeq, 0);
assert.equal(payload.syntax.refs[1].fileRecordId, capture.fileId);
assert.equal('rootId' in payload, false);
assert.equal('relativePath' in payload, false);
process.stdout.write(JSON.stringify({ builtNodeEntry: true, chunks: payload.providedChunks.length, refs: payload.syntax.refs.length }));
`;

it('loads the built public mapper in plain Node and preserves the canonical recording', async () => {
  const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: new URL('../../', import.meta.url),
    timeout: 10_000,
  });
  expect(JSON.parse(stdout) as unknown).toEqual({ builtNodeEntry: true, chunks: 2, refs: 3 });
});
