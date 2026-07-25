#!/usr/bin/env node

// Guard: R6 in docs/agents/mastra-boundary.md makes Brainstrike's StreamChunk
// mapper the UI/persistence boundary. Mastra upgrades are allowed to add chunk
// types, but the new type must fail CI until it has a deliberate disposition;
// runtime-only parts must log a coded diagnostic instead of disappearing.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const AGENT_STREAMING_FILE = 'packages/agent/src/mastra/agent-streaming.ts';
const DATA_STREAM_MAPPER_FILE = 'packages/agent/src/stream/data-stream-mapper.ts';
const TOOL_EVENT_MAPPER_FILE = 'packages/agent/src/mastra/tool-event-mapper.ts';

const REQUIRED_MARKERS = [
  {
    filePath: AGENT_STREAMING_FILE,
    markers: [
      "import type { ChunkType } from '@mastra/core/stream';",
      "type StaticMastraChunkType = Exclude<ChunkType['type'], DynamicMastraChunkType>;",
      'satisfies Record<StaticMastraChunkType, true>;',
      "code: 'mastra_agent_unrecognized_stream_chunk',",
    ],
  },
  {
    filePath: DATA_STREAM_MAPPER_FILE,
    markers: ["code: 'data_stream_mapper_unrecognized_chunk',"],
  },
  {
    filePath: TOOL_EVENT_MAPPER_FILE,
    markers: ["code: 'mastra_tool_event_unrecognized_stream_chunk',"],
  },
];

/**
 * Returns violations for the R6 unknown-chunk contract. The guard intentionally
 * examines only the three load-bearing dispatch files; a broad search would
 * make adding an unrelated diagnostic appear to satisfy this boundary.
 */
export async function findMastraStreamChunkContractViolations({ root = REPO_ROOT } = {}) {
  const violations = [];

  for (const { filePath, markers } of REQUIRED_MARKERS) {
    let source;
    try {
      source = await readFile(path.join(root, filePath), 'utf8');
    } catch (error) {
      violations.push({
        filePath,
        reason: `could not read required R6 dispatch file: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    for (const marker of markers) {
      if (!source.includes(marker)) {
        violations.push({
          filePath,
          reason: `missing R6 contract marker ${JSON.stringify(marker)}`,
        });
      }
    }
  }

  return { violations };
}

async function main() {
  const { violations } = await findMastraStreamChunkContractViolations();
  if (violations.length === 0) {
    console.log(
      'Mastra stream chunk contract intact: typed coverage and coded diagnostics are present.'
    );
    return;
  }

  console.error(
    'Mastra stream chunk contract failed. See docs/agents/mastra-boundary.md R6. Violations:'
  );
  for (const violation of violations) {
    console.error(`- ${violation.filePath} — ${violation.reason}`);
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
