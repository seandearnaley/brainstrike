import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findMastraStreamChunkContractViolations } from '../mastra-stream-chunk-contract.mjs';

const DATA_STREAM_MAPPER_FILE = 'packages/agent/src/stream/data-stream-mapper.ts';
const COMPLIANT_FILES = {
  [DATA_STREAM_MAPPER_FILE]: `class DataStreamMapper {
  handleChunk(chunk) {
    switch (chunk.type) {
      default:
        logger.warn('unrecognized', { code: 'data_stream_mapper_unrecognized_chunk' });
        return;
    }
  }
}
`,
};

async function writeFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mastra-stream-chunk-contract-'));
  for (const [relativePath, source] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, source);
  }
  return root;
}

test('real tree: R6 keeps the live StreamChunk dispatch observable', async () => {
  const { violations } = await findMastraStreamChunkContractViolations();
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `  - ${v.filePath} — ${v.reason}`).join('\n')
  );
});

test('accepts the coded live dispatch without requiring the retired Mastra mapper', async () => {
  const root = await writeFixture(COMPLIANT_FILES);
  const { violations } = await findMastraStreamChunkContractViolations({ root });
  assert.deepEqual(violations, []);
});

test('flags the deliberately silent live default that R6 forbids', async () => {
  const root = await writeFixture({
    [DATA_STREAM_MAPPER_FILE]: 'return { chunks: [], finished: false };\n',
  });
  const { violations } = await findMastraStreamChunkContractViolations({ root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].filePath, DATA_STREAM_MAPPER_FILE);
  assert.match(violations[0].reason, /data_stream_mapper_unrecognized_chunk/);
});

test('flags a live dispatch file that has gone missing entirely', async () => {
  const root = await writeFixture({});
  const { violations } = await findMastraStreamChunkContractViolations({ root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].filePath, DATA_STREAM_MAPPER_FILE);
  assert.match(violations[0].reason, /could not read/);
});

test('rejects coded warning text outside the protected live dispatch default', async () => {
  const root = await writeFixture({
    [DATA_STREAM_MAPPER_FILE]: `logger.warn('elsewhere', { code: 'data_stream_mapper_unrecognized_chunk' });
class DataStreamMapper {
  handleChunk(chunk) {
    switch (chunk.type) {
      default:
        return;
    }
  }
}
`,
  });
  const { violations } = await findMastraStreamChunkContractViolations({ root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].filePath, DATA_STREAM_MAPPER_FILE);
  assert.match(violations[0].reason, /data_stream_mapper_unrecognized_chunk/);
});
