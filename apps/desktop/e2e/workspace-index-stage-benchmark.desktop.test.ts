import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';

type StageBenchmarkMode = 'db-completion-ceiling';

interface StageBenchmarkResult {
  chunkCount: number;
  chunksPerSecond: number;
  completedAt: string;
  completedChunkCount: number;
  dimensions: number;
  elapsedMs: number;
  mode: string;
  startedAt: string;
}

interface WorkspaceIndexDebugSnapshot {
  runtimeReadiness?: {
    message?: string | null;
    missingDependencies?: string[];
    serviceAvailable?: boolean;
  };
}

const MODE_ENV = 'BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_MODE';
const CHUNK_COUNT_ENV = 'BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_CHUNKS';
const DIMENSIONS_ENV = 'BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_DIMENSIONS';
const EVIDENCE_PATH_ENV = 'BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_EVIDENCE_PATH';

function parsePositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseMode(): StageBenchmarkMode {
  const mode = process.env[MODE_ENV]?.trim() || 'db-completion-ceiling';
  if (mode !== 'db-completion-ceiling') {
    throw new Error(`Unsupported Workspace Index stage benchmark mode: ${mode}`);
  }
  return mode;
}

async function waitForWorkspaceIndexDebugApi(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (
        globalThis as typeof globalThis & {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: unknown;
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ === 'object',
    undefined,
    { timeout: 60_000 }
  );
}

async function waitForWorkspaceIndexBenchmarkReadiness(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const api = (
        globalThis as typeof globalThis & {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
            snapshot?: () => Promise<WorkspaceIndexDebugSnapshot>;
          };
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;
      if (typeof api?.snapshot !== 'function') {
        return false;
      }
      const snapshot = await api.snapshot();
      const missingDependencies = snapshot.runtimeReadiness?.missingDependencies ?? [];
      return (
        snapshot.runtimeReadiness?.serviceAvailable === true && missingDependencies.length === 0
      );
    },
    undefined,
    { timeout: 60_000 }
  );
}

async function runStageBenchmark(
  page: Page,
  request: { chunkCount: number; dimensions: number; mode: StageBenchmarkMode }
): Promise<StageBenchmarkResult> {
  return await page.evaluate(async (benchmarkRequest) => {
    const api = (
      globalThis as typeof globalThis & {
        __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
          benchmarkStage?: (request: typeof benchmarkRequest) => Promise<StageBenchmarkResult>;
        };
      }
    ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;
    if (typeof api?.benchmarkStage !== 'function') {
      throw new Error('window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__.benchmarkStage is unavailable');
    }
    return await api.benchmarkStage(benchmarkRequest);
  }, request);
}

test.describe('Workspace Index stage benchmark', () => {
  test('@desktop-workspace-index-stage-benchmark runs the requested stage benchmark', async ({
    window: page,
  }, testInfo) => {
    test.setTimeout(300_000);
    const mode = parseMode();
    const request = {
      chunkCount: parsePositiveIntegerEnv(CHUNK_COUNT_ENV, 512),
      dimensions: parsePositiveIntegerEnv(DIMENSIONS_ENV, 384),
      mode,
    };

    await waitForWorkspaceIndexDebugApi(page);
    await waitForWorkspaceIndexBenchmarkReadiness(page);
    const result = await runStageBenchmark(page, request);

    expect(result.mode).toBe(mode);
    expect(result.chunkCount).toBe(request.chunkCount);
    expect(result.dimensions).toBe(request.dimensions);
    expect(result.completedChunkCount).toBe(request.chunkCount);
    expect(result.chunksPerSecond).toBeGreaterThan(0);

    const evidencePath =
      process.env[EVIDENCE_PATH_ENV]?.trim() ||
      testInfo.outputPath(`workspace-index-stage-benchmark-${mode}.json`);
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          request,
          result,
        },
        null,
        2
      ),
      'utf8'
    );
  });
});
