#!/usr/bin/env node

// Lightweight chunking memory benchmark (streaming vs aggregate)

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function main() {
  const { ChunkingService, CHUNKING_CONFIG } = await import(
    path.join(root, 'packages/db/dist/index.js')
  );

  const sizeMB = Number(process.env.BENCH_SIZE_MB || '5');
  const repeat = Math.max(1, Math.floor((sizeMB * 1024 * 1024) / 12));

  // Synthetic text (~12 bytes per token-ish): 'word. '
  const content = 'word. '.repeat(repeat);
  const service = new ChunkingService();

  const options = {
    fileName: 'big.txt',
    filePath: '/big.txt',
    maxTokens: CHUNKING_CONFIG.defaultMaxTokens,
    overlap: CHUNKING_CONFIG.defaultOverlap,
    strategy: 'sentence',
  };

  const _base = process.memoryUsage().rss;

  // Aggregate path (materialize all chunks from streaming)
  const rssBeforeAgg = process.memoryUsage().rss;
  const agg = [];
  for await (const ch of service.chunkContentStream(content, 'file-agg', {
    ...options,
    allowLargeFiles: true,
  })) {
    agg.push(ch);
  }
  const rssAfterAgg = process.memoryUsage().rss;
  const deltaAgg = (rssAfterAgg - rssBeforeAgg) / (1024 * 1024);

  // Streaming path
  let chunksStream = 0;
  const rssBeforeStr = process.memoryUsage().rss;
  for await (const _ of service.chunkContentStream(content, 'file-str', {
    ...options,
    allowLargeFiles: true,
  })) {
    chunksStream += 1;
  }
  const rssAfterStr = process.memoryUsage().rss;
  const deltaStr = (rssAfterStr - rssBeforeStr) / (1024 * 1024);

  console.log(
    JSON.stringify(
      {
        chunksAggregate: agg.length,
        chunksStream,
        memoryDeltaMB: {
          aggregate: Number(deltaAgg.toFixed(2)),
          streaming: Number(deltaStr.toFixed(2)),
        },
        platform: os.platform(),
        sizeMB,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
