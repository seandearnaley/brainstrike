#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DESKTOP_APP_ROOT, '../..');
const DEFAULT_EVIDENCE_ROOTS = [
  path.join(DESKTOP_APP_ROOT, 'test-results'),
  path.join(DESKTOP_APP_ROOT, 'blob-report'),
];
const BENCHMARK_MODES = new Set([
  'embedding-ceiling',
  'db-completion-ceiling',
  'chunking-ceiling',
  'import-ceiling',
  'integrated',
]);
const RUNNABLE_STAGE_BENCHMARK_MODES = new Set(['db-completion-ceiling']);

const FATAL_LOG_PATTERN =
  /DB host request timed out|Local embedding execution failed|uncaught|unhandled/i;

function readNumber(row, key) {
  const value = row?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function sumRows(rows, key) {
  if (!Array.isArray(rows)) {
    return 0;
  }
  return rows.reduce((total, row) => total + readNumber(row, key), 0);
}

function normalizeSamples(evidence) {
  const rawSamples = Array.isArray(evidence.samples)
    ? evidence.samples
    : Array.isArray(evidence.snapshots)
      ? evidence.snapshots
      : [];
  return rawSamples.map((sample, index) => {
    if (sample && typeof sample === 'object' && 'snapshot' in sample) {
      return {
        elapsedMs: readNumber(sample, 'elapsedMs') || index * 5000,
        snapshot: sample.snapshot,
      };
    }
    return {
      elapsedMs: index * 5000,
      snapshot: sample,
    };
  });
}

function getEmbeddingRuntime(snapshot) {
  const hostStatus = snapshot?.embeddingHostStatus;
  if (!(hostStatus && typeof hostStatus === 'object')) {
    return null;
  }
  const status = hostStatus.status;
  if (!(status && typeof status === 'object')) {
    return null;
  }
  const runtime = status.embeddingRuntime;
  return runtime && typeof runtime === 'object' ? runtime : null;
}

function getActualWorkerMetadata(snapshot) {
  const runtime = getEmbeddingRuntime(snapshot);
  const metadata = runtime?.actualWorkerMetadata;
  return metadata && typeof metadata === 'object' ? metadata : null;
}

function getSnapshotCounts(snapshot) {
  return {
    chunkCount: sumRows(snapshot?.chunkStatsByRoot, 'chunk_count'),
    chunkedFileCount: sumRows(snapshot?.fileRecordsByRoot, 'chunked_file_count'),
    embeddedChunkCount: sumRows(snapshot?.chunkStatsByRoot, 'embedded_chunk_count'),
    expectedFileCount: Array.isArray(snapshot?.expectedCounts)
      ? snapshot.expectedCounts.reduce(
          (total, root) => total + readNumber(root, 'expectedFileCount'),
          0
        )
      : 0,
    fileRecordCount: sumRows(snapshot?.fileRecordsByRoot, 'file_count'),
  };
}

function hasBlockingQueueWork(snapshot) {
  return Array.isArray(snapshot?.jobQueue)
    ? snapshot.jobQueue.some((row) => {
        const state = String(row?.state ?? '');
        return state === 'queued' || state === 'running' || state === 'failed';
      })
    : false;
}

function getFatalLogMatches(evidence) {
  const explicit = evidence.fatalLogMatches ?? evidence.logScan?.fatalMatches;
  if (Array.isArray(explicit)) {
    return explicit.map(String).filter((value) => value.length > 0);
  }
  const logs = Array.isArray(evidence.logs) ? evidence.logs : [];
  return logs
    .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    .filter((entry) => FATAL_LOG_PATTERN.test(entry));
}

function getHeapUsedMb(snapshot) {
  const memory = snapshot?.memorySample;
  if (!(memory && typeof memory === 'object')) {
    return null;
  }
  const bytes = readNumber(memory, 'usedJSHeapSize');
  return bytes > 0 ? bytes / (1024 * 1024) : null;
}

function resolveBottleneck(stageCeilings) {
  const values = [
    stageCeilings?.embeddingCeilingChunksPerSecond,
    stageCeilings?.dbCompletionCeilingChunksPerSecond,
    stageCeilings?.chunkingCeilingChunksPerSecond,
    stageCeilings?.importCeilingEquivalentChunksPerSecond,
  ].filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return values.length === 4 ? Math.min(...values) : null;
}

function roundMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

export function analyzeWorkspaceIndexEvidence(evidence, options = {}) {
  const samples = normalizeSamples(evidence);
  if (samples.length === 0) {
    throw new Error('Workspace Index evidence contains no samples.');
  }

  const fatalLogMatches = getFatalLogMatches(evidence);
  if (fatalLogMatches.length > 0) {
    throw new Error(`Workspace Index evidence contains fatal log patterns: ${fatalLogMatches[0]}`);
  }

  const finalSample = samples.at(-1);
  const finalSnapshot = finalSample?.snapshot;
  const finalCounts = getSnapshotCounts(finalSnapshot);
  if (
    finalCounts.expectedFileCount <= 0 ||
    finalCounts.fileRecordCount !== finalCounts.expectedFileCount ||
    finalCounts.chunkedFileCount !== finalCounts.expectedFileCount ||
    finalCounts.chunkCount <= 0 ||
    finalCounts.embeddedChunkCount !== finalCounts.chunkCount ||
    hasBlockingQueueWork(finalSnapshot)
  ) {
    throw new Error(
      `Workspace Index did not complete: ${JSON.stringify(finalCounts)}, blockingQueue=${hasBlockingQueueWork(
        finalSnapshot
      )}`
    );
  }

  const syncState = finalSnapshot?.syncStatus?.state;
  if (syncState === 'blocked' || syncState === 'error') {
    throw new Error(`Workspace Index terminal state is ${syncState}.`);
  }

  const actualMetadata = [...samples]
    .reverse()
    .map((sample) => getActualWorkerMetadata(sample.snapshot))
    .find((metadata) => metadata !== null);
  if (!actualMetadata) {
    throw new Error('Workspace Index evidence has no actual embedding worker metadata.');
  }

  const requiredDevice = options.requireDevice ?? evidence.requiredDevice;
  if (requiredDevice && actualMetadata.device !== requiredDevice) {
    throw new Error(
      `Workspace Index actual embedding backend mismatch: expected ${requiredDevice}, got ${actualMetadata.device}`
    );
  }
  if (actualMetadata.fallbackApplied === true) {
    throw new Error('Workspace Index actual embedding runtime reported fallbackApplied=true.');
  }

  const maxHeapUsedMb = Math.max(
    0,
    ...samples
      .map((sample) => getHeapUsedMb(sample.snapshot))
      .filter((value) => typeof value === 'number')
  );
  if (
    typeof options.maxRetainedHeapMb === 'number' &&
    maxHeapUsedMb > options.maxRetainedHeapMb
  ) {
    throw new Error(
      `Workspace Index retained heap exceeded limit: ${roundMetric(maxHeapUsedMb)}MB > ${options.maxRetainedHeapMb}MB`
    );
  }

  const firstProgressIndex = samples.findIndex(
    (sample) => getSnapshotCounts(sample.snapshot).embeddedChunkCount > 0
  );
  const firstThroughputSample =
    firstProgressIndex > 0 ? samples[firstProgressIndex - 1] : samples[0];
  const firstCounts = getSnapshotCounts(firstThroughputSample.snapshot);
  const elapsedSeconds = Math.max(
    0.001,
    (finalSample.elapsedMs - firstThroughputSample.elapsedMs) / 1000
  );
  const embeddedDelta = Math.max(0, finalCounts.embeddedChunkCount - firstCounts.embeddedChunkCount);
  const integratedChunksPerSecond = embeddedDelta / elapsedSeconds;
  const bottleneckChunksPerSecond = resolveBottleneck(options.stageCeilings);
  const integratedToBottleneckRatio =
    bottleneckChunksPerSecond === null ? null : integratedChunksPerSecond / bottleneckChunksPerSecond;

  if (
    typeof options.minIntegratedToBottleneckRatio === 'number' &&
    (integratedToBottleneckRatio === null ||
      integratedToBottleneckRatio < options.minIntegratedToBottleneckRatio)
  ) {
    throw new Error(
      `Workspace Index throughput ratio ${roundMetric(
        integratedToBottleneckRatio
      )} is below ${options.minIntegratedToBottleneckRatio}.`
    );
  }

  return {
    actualWorkerMetadata: actualMetadata,
    bottleneckChunksPerSecond: roundMetric(bottleneckChunksPerSecond),
    durationMs: finalSample.elapsedMs - samples[0].elapsedMs,
    finalCounts,
    integratedChunksPerSecond: roundMetric(integratedChunksPerSecond),
    integratedToBottleneckRatio: roundMetric(integratedToBottleneckRatio),
    maxHeapUsedMb: roundMetric(maxHeapUsedMb),
    requiredDevice: requiredDevice ?? null,
    sampleCount: samples.length,
    stageCeilings: options.stageCeilings ?? null,
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    evidencePath: null,
    maxRetainedHeapMb: null,
    minIntegratedToBottleneckRatio: null,
    modes: ['integrated'],
    profile: null,
    requireDevice: null,
    stageCeilings: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };
    if (arg === '--evidence') {
      options.evidencePath = path.resolve(next());
    } else if (arg === '--require-device') {
      options.requireDevice = next();
    } else if (arg === '--max-retained-heap-mb') {
      options.maxRetainedHeapMb = Number(next());
    } else if (arg === '--min-ratio') {
      options.minIntegratedToBottleneckRatio = Number(next());
    } else if (arg === '--mode') {
      const mode = next();
      if (!BENCHMARK_MODES.has(mode)) {
        throw new Error(
          `Unknown benchmark mode: ${mode}. Expected one of: ${[...BENCHMARK_MODES].join(', ')}`
        );
      }
      if (options.modes.length === 1 && options.modes[0] === 'integrated') {
        options.modes = [];
      }
      options.modes.push(mode);
    } else if (arg === '--stage-ceiling') {
      const [key, rawValue] = next().split('=');
      const value = Number(rawValue);
      if (!key || !Number.isFinite(value) || value <= 0) {
        throw new Error('--stage-ceiling requires key=positive-number');
      }
      options.stageCeilings[key] = value;
    } else if (arg === '--profile') {
      options.profile = next();
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function assertRunnableBenchmarkModes(options) {
  const unsupportedModes = options.modes.filter(
    (mode) => mode !== 'integrated' && !RUNNABLE_STAGE_BENCHMARK_MODES.has(mode)
  );
  if (unsupportedModes.length > 0) {
    throw new Error(
      `Workspace Index benchmark mode '${unsupportedModes[0]}' requires the Electron stage benchmark harness. Current CLI only validates integrated full-run evidence; refusing to silently ignore requested stage mode(s): ${unsupportedModes.join(
        ', '
      )}.`
    );
  }
}

function getStageBenchmarkModes(options) {
  return options.modes.filter((mode) => mode !== 'integrated');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stderr, stdout });
        return;
      }
      reject(
        new Error(
          `Command failed (${code}): ${command} ${args.join(' ')}\n${stdout}\n${stderr}`.trim()
        )
      );
    });
  });
}

export async function runElectronStageBenchmarks(options) {
  const stageModes = getStageBenchmarkModes(options);
  const results = {};
  for (const mode of stageModes) {
    if (!RUNNABLE_STAGE_BENCHMARK_MODES.has(mode)) {
      throw new Error(`Workspace Index benchmark mode '${mode}' is not runnable.`);
    }
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-stage-benchmark-'));
    const evidencePath = path.join(outputDir, `${mode}.json`);
    await runCommand(
      'pnpm',
      [
        '--dir',
        DESKTOP_APP_ROOT,
        'exec',
        'xvfb-maybe',
        'pnpm',
        'exec',
        'playwright',
        'test',
        'e2e/workspace-index-stage-benchmark.desktop.test.ts',
        '--project=regression',
        '--workers=1',
        '--retries=0',
        '--max-failures=1',
        '--global-timeout=300000',
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_CHUNKS:
            String(options.stageBenchmarkChunkCount ?? 512),
          BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_DIMENSIONS:
            String(options.stageBenchmarkDimensions ?? 384),
          BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_EVIDENCE_PATH: evidencePath,
          BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_MODE: mode,
          LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
          NO_COLOR: process.env.NO_COLOR ?? '',
        },
      }
    );
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    results[mode] = {
      evidencePath,
      ...evidence.result,
    };
  }
  return results;
}

async function findEvidenceFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return await findEvidenceFiles(entryPath);
      }
      return entry.name === 'full-workspace-index-evidence.json' ? [entryPath] : [];
    })
  );
  return nested.flat();
}

export async function findLatestWorkspaceIndexEvidencePath(options = {}) {
  const searchRoots = Array.isArray(options.searchRoots)
    ? options.searchRoots
    : DEFAULT_EVIDENCE_ROOTS;
  const files = (await Promise.all(searchRoots.map((root) => findEvidenceFiles(root)))).flat();
  if (files.length === 0) {
    throw new Error(
      `No full-workspace-index-evidence.json found under ${searchRoots.join(
        ', '
      )}. Run the full Workspace Index verifier or pass --evidence.`
    );
  }
  const stats = await Promise.all(
    files.map(async (filePath) => ({
      filePath,
      mtimeMs: (await stat(filePath)).mtimeMs,
    }))
  );
  stats.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return stats[0].filePath;
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      'Usage: node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs --profile isolated --require-device webgpu [--mode integrated] [--evidence <path>] [--stage-ceiling embeddingCeilingChunksPerSecond=20]'
    );
    return;
  }
  assertRunnableBenchmarkModes(options);
  const stageBenchmarks = await runElectronStageBenchmarks(options);
  const shouldAnalyzeIntegrated = options.modes.includes('integrated');
  let evidencePath = null;
  let result = null;
  if (shouldAnalyzeIntegrated) {
    evidencePath = options.evidencePath ?? (await findLatestWorkspaceIndexEvidencePath());
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    result = analyzeWorkspaceIndexEvidence(evidence, options);
  }
  console.log(
    JSON.stringify(
      {
        ...(evidencePath ? { evidencePath } : {}),
        ...(result ?? {}),
        stageBenchmarks,
      },
      null,
      2
    )
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
