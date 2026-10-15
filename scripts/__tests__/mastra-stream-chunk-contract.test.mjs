import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findMastraStreamChunkContractViolations } from '../mastra-stream-chunk-contract.mjs';

const AGENT_STREAMING_FILE = 'packages/agent/src/mastra/agent-streaming.ts';
const DATA_STREAM_MAPPER_FILE = 'packages/agent/src/stream/data-stream-mapper.ts';
const TOOL_EVENT_MAPPER_FILE = 'packages/agent/src/tool-projection/tool-event-mapper.ts';

const COMPLIANT_FILES = {
  [AGENT_STREAMING_FILE]: `import type { ChunkType } from '@mastra/core/stream';
type MastraChunkTypeMustStayLiteral = string extends ChunkType['type'] ? never : true;
const MASTRA_CHUNK_TYPE_MUST_STAY_LITERAL: MastraChunkTypeMustStayLiteral = true;
type StaticMastraChunkType = Exclude<ChunkType['type'], DynamicMastraChunkType>;
type MastraStaticChunkDisposition = 'ignored' | 'mapped';
const MASTRA_STATIC_CHUNK_DISPOSITIONS = {} satisfies Record<
  StaticMastraChunkType,
  MastraStaticChunkDisposition
>;
function warnForUnrecognizedMastraStreamPart() {
  logger.warn('unrecognized', { code: 'mastra_agent_unrecognized_stream_chunk' });
}
function processMastraStreamPart(part) {
  switch (part.type) {
    default:
      warnForUnrecognizedMastraStreamPart();
      return;
  }
}
`,
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
  [TOOL_EVENT_MAPPER_FILE]: `function mapMastraToolEvent(candidate) {
  switch (candidate.type) {
    default:
      logger.warn('unrecognized', { code: 'mastra_tool_event_unrecognized_stream_chunk' });
      return;
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

test('real tree: R6 keeps the Mastra chunk union typed and every dispatch observable', async () => {
  const { violations } = await findMastraStreamChunkContractViolations();
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `  - ${v.filePath} — ${v.reason}`).join('\n')
  );
});

test('accepts the typed coverage and coded diagnostics in all three dispatch files', async () => {
  const root = await writeFixture(COMPLIANT_FILES);
  const { violations } = await findMastraStreamChunkContractViolations({ root });
  assert.deepEqual(violations, []);
});

test('flags the deliberately silent default that the R6 policy forbids', async () => {
  const root = await writeFixture({
    ...COMPLIANT_FILES,
    [AGENT_STREAMING_FILE]: `const MASTRA_STATIC_CHUNK_DISPOSITIONS = {};
return { chunks: [], finished: false };
`,
    [TOOL_EVENT_MAPPER_FILE]: 'return undefined;\n',
  });
  const { violations } = await findMastraStreamChunkContractViolations({ root });
  const reasons = violations.map((v) => v.reason);

  assert.ok(reasons.some((reason) => reason.includes("ChunkType } from '@mastra/core/stream'")));
  assert.ok(reasons.some((reason) => reason.includes('StaticMastraChunkType')));
  assert.ok(reasons.some((reason) => reason.includes('MastraChunkTypeMustStayLiteral')));
  assert.ok(reasons.some((reason) => reason.includes('MastraStaticChunkDisposition')));
  assert.ok(reasons.some((reason) => reason.includes('mastra_agent_unrecognized_stream_chunk')));
  assert.ok(
    reasons.some((reason) => reason.includes('mastra_tool_event_unrecognized_stream_chunk'))
  );
});

test('rejects coded warning text outside the protected dispatch default', async () => {
  const root = await writeFixture({
    ...COMPLIANT_FILES,
    [TOOL_EVENT_MAPPER_FILE]: `logger.warn('elsewhere', {
  code: 'mastra_tool_event_unrecognized_stream_chunk',
});
function mapMastraToolEvent(candidate) {
  switch (candidate.type) {
    default:
      return;
  }
}
`,
  });
  const { violations } = await findMastraStreamChunkContractViolations({ root });
  assert.ok(
    violations.some(
      ({ filePath, reason }) =>
        filePath === TOOL_EVENT_MAPPER_FILE &&
        reason.includes('mastra_tool_event_unrecognized_stream_chunk')
    )
  );
});
