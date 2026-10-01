import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
  CHUNKING_HOST_CHUNK_FILE_CHANNEL,
  CHUNKING_HOST_ENSURE_STARTED_CHANNEL,
  CHUNKING_HOST_GET_STATUS_CHANNEL,
  CHUNKING_HOST_PROGRESS_EVENT,
  CHUNKING_HOST_REPORT_RESPONSE_CHANNEL,
  CHUNKING_HOST_REPORT_STATUS_CHANNEL,
  CHUNKING_HOST_REQUEST_EVENT,
  CHUNKING_HOST_RESET_CHANNEL,
  CHUNKING_HOST_STATUS_EVENT,
  CHUNKING_HOST_STOP_CHANNEL,
} from '../../chunking-host-shared';
import {
  EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
  EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
  EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
  EMBEDDING_HOST_COMMAND_EVENT,
  EMBEDDING_HOST_DOWNLOAD_MODEL_CHANNEL,
  EMBEDDING_HOST_DOWNLOAD_PROGRESS_EVENT,
  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT,
  EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
  EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
  EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STATUS_EVENT,
  EMBEDDING_HOST_STOP_CHANNEL,
} from '../../embedding-host-shared';
import {
  LLM_HOST_CANCEL_CHANNEL,
  LLM_HOST_ENSURE_STARTED_CHANNEL,
  LLM_HOST_GENERATE_CHANNEL,
  LLM_HOST_GET_STATUS_CHANNEL,
  LLM_HOST_PROGRESS_EVENT,
  LLM_HOST_REPORT_PROGRESS_CHANNEL,
  LLM_HOST_REPORT_RESPONSE_CHANNEL,
  LLM_HOST_REPORT_STATUS_CHANNEL,
  LLM_HOST_REQUEST_EVENT,
  LLM_HOST_RESET_CHANNEL,
  LLM_HOST_STATUS_EVENT,
  LLM_HOST_STOP_CHANNEL,
  LLM_HOST_WARMUP_CHANNEL,
} from '../../llm-host-shared';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import { LOGGING_API_CHANNELS } from '../../platform/logging-api-contract';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const DIRECT_REGISTRY_CHANNEL_PATTERN =
  /registry\.register(?:Invoke|Event)\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]/g;
const DIRECT_WEB_CONTENTS_SEND_CHANNEL_PATTERN = /webContents\.send\(\s*['"][^'"]+['"]/g;

function listProductionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist') {
        continue;
      }
      files.push(...listProductionTypeScriptFiles(absolutePath));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe('desktop IPC channel contract', () => {
  it('keeps shared platform channel constants owned by the central catalog', () => {
    const workspaceContextToolsSource = readFileSync(
      path.join(SOURCE_ROOT, 'assistant-server', 'workspace-context-tools.ts'),
      'utf8'
    );
    const dbSharedSource = readFileSync(path.join(SOURCE_ROOT, 'db-shared.ts'), 'utf8');
    const embeddingHostSource = readFileSync(
      path.join(SOURCE_ROOT, 'embedding-host-shared.ts'),
      'utf8'
    );
    const parserHostSource = readFileSync(path.join(SOURCE_ROOT, 'parser-host-shared.ts'), 'utf8');
    const runtimeSource = readFileSync(path.join(SOURCE_ROOT, 'ipc-runtime.ts'), 'utf8');

    expect(workspaceContextToolsSource).toContain("from '../platform/desktop-ipc-channels'");
    expect(workspaceContextToolsSource).not.toMatch(/WORKSPACE_CONTEXT_[A-Z_]+_EVENT\s*=\s*['"]/);
    expect(dbSharedSource).toContain("from './platform/desktop-ipc-channels'");
    expect(dbSharedSource).not.toMatch(/DB_[A-Z_]+_CHANNEL\s*=\s*['"]/);
    expect(embeddingHostSource).not.toMatch(/EMBEDDING_HOST_[A-Z_]+_(?:CHANNEL|EVENT)\s*=\s*['"]/);
    expect(parserHostSource).toContain("from './platform/desktop-ipc-channels'");
    expect(parserHostSource).not.toMatch(/PARSER_HOST_PARSE_CHANNEL\s*=\s*['"]/);
    expect(runtimeSource).toContain("from './platform/desktop-ipc-channels'");
    expect(runtimeSource).not.toMatch(/RUNTIME_[A-Z_]+_CHANNEL\s*=\s*['"]/);
  });

  it('keeps production registry channel names behind named contracts', () => {
    const violations: string[] = [];

    for (const filePath of listProductionTypeScriptFiles(SOURCE_ROOT)) {
      const source = readFileSync(filePath, 'utf8');
      if (!source.includes('registry.register')) {
        continue;
      }
      for (const match of source.matchAll(DIRECT_REGISTRY_CHANNEL_PATTERN)) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(SOURCE_ROOT, filePath)}:${lineNumber}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps production webContents send channel names behind named contracts', () => {
    const violations: string[] = [];

    for (const filePath of listProductionTypeScriptFiles(SOURCE_ROOT)) {
      const source = readFileSync(filePath, 'utf8');
      if (!source.includes('webContents.send')) {
        continue;
      }
      for (const match of source.matchAll(DIRECT_WEB_CONTENTS_SEND_CHANNEL_PATTERN)) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(SOURCE_ROOT, filePath)}:${lineNumber}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the hidden-host manifest groups in parity with the worker-runtime descriptors', () => {
    // BST-1648: the pure manifest is what the sandboxed preloads bundle; the
    // `*-host-shared.ts` descriptors (derived by @brainstrike/worker-runtime,
    // a bare package a preload cannot require) are what main registers. The
    // two are pinned equal here so neither can drift from the other.
    expect(DESKTOP_IPC_CHANNELS.chunkingHost).toEqual({
      chunkBatch: CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
      chunkFile: CHUNKING_HOST_CHUNK_FILE_CHANNEL,
      ensureStarted: CHUNKING_HOST_ENSURE_STARTED_CHANNEL,
      getStatus: CHUNKING_HOST_GET_STATUS_CHANNEL,
      progress: CHUNKING_HOST_PROGRESS_EVENT,
      reportResponse: CHUNKING_HOST_REPORT_RESPONSE_CHANNEL,
      reportStatus: CHUNKING_HOST_REPORT_STATUS_CHANNEL,
      request: CHUNKING_HOST_REQUEST_EVENT,
      reset: CHUNKING_HOST_RESET_CHANNEL,
      status: CHUNKING_HOST_STATUS_EVENT,
      stop: CHUNKING_HOST_STOP_CHANNEL,
    });
    expect(DESKTOP_IPC_CHANNELS.embeddingHost).toEqual({
      backfillProgress: EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
      cancelAllBackfills: EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
      cancelBackfill: EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
      command: EMBEDDING_HOST_COMMAND_EVENT,
      downloadModel: EMBEDDING_HOST_DOWNLOAD_MODEL_CHANNEL,
      downloadProgress: EMBEDDING_HOST_DOWNLOAD_PROGRESS_EVENT,
      enqueueBackfill: EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
      ensureStarted: EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
      getBackfillsInFlight: EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL,
      getStatus: EMBEDDING_HOST_GET_STATUS_CHANNEL,
      queryEmbedding: EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
      queryEmbeddingCancel: EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT,
      queryEmbeddingRequest: EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
      reportQueryEmbeddingResponse: EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
      reportStatus: EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
      reset: EMBEDDING_HOST_RESET_CHANNEL,
      status: EMBEDDING_HOST_STATUS_EVENT,
      stop: EMBEDDING_HOST_STOP_CHANNEL,
    });
    expect(DESKTOP_IPC_CHANNELS.llmHost).toEqual({
      cancel: LLM_HOST_CANCEL_CHANNEL,
      ensureStarted: LLM_HOST_ENSURE_STARTED_CHANNEL,
      generate: LLM_HOST_GENERATE_CHANNEL,
      getStatus: LLM_HOST_GET_STATUS_CHANNEL,
      progress: LLM_HOST_PROGRESS_EVENT,
      reportProgress: LLM_HOST_REPORT_PROGRESS_CHANNEL,
      reportResponse: LLM_HOST_REPORT_RESPONSE_CHANNEL,
      reportStatus: LLM_HOST_REPORT_STATUS_CHANNEL,
      request: LLM_HOST_REQUEST_EVENT,
      reset: LLM_HOST_RESET_CHANNEL,
      status: LLM_HOST_STATUS_EVENT,
      stop: LLM_HOST_STOP_CHANNEL,
      warmup: LLM_HOST_WARMUP_CHANNEL,
    });
  });

  it('keeps the logging API channels owned by the manifest', () => {
    expect(LOGGING_API_CHANNELS).toBe(DESKTOP_IPC_CHANNELS.logging);
  });

  it('keeps every manifest channel unique across groups', () => {
    const channels = Object.values(DESKTOP_IPC_CHANNELS).flatMap((group) => Object.values(group));
    expect(new Set(channels).size).toBe(channels.length);
  });
});
