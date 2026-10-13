#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DESKTOP_APP_ROOT, '../..');
const INTEGRATED_BENCHMARK_LANE = 'test:e2e:lane:foreground-latency';
const INTEGRATED_BENCHMARK_SCHEMA = 'brainstrike.foreground-latency-under-index-build.v2';
const STAGE_BENCHMARK_MODES = new Set([
  'chunking-ceiling',
  'db-completion-ceiling',
  'embedding-ceiling',
  'import-ceiling',
]);
/** Stage modes run e2e/workspace-index-stage-benchmark; `integrated` runs the full-build lane. */
const BENCHMARK_MODES = new Set([...STAGE_BENCHMARK_MODES, 'integrated']);

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
  if (typeof options.maxRetainedHeapMb === 'number' && maxHeapUsedMb > options.maxRetainedHeapMb) {
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
  const embeddedDelta = Math.max(
    0,
    finalCounts.embeddedChunkCount - firstCounts.embeddedChunkCount
  );
  const integratedChunksPerSecond = embeddedDelta / elapsedSeconds;
  const bottleneckChunksPerSecond = resolveBottleneck(options.stageCeilings);
  const integratedToBottleneckRatio =
    bottleneckChunksPerSecond === null
      ? null
      : integratedChunksPerSecond / bottleneckChunksPerSecond;

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

/**
 * Validates evidence written by e2e/foreground-latency-under-index-build.desktop.test.ts
 * and returns it without the raw sample arrays. An invalid run is an error, never
 * a set of numbers, and so is a run on a device other than `options.requireDevice`.
 */
export function summarizeIntegratedBenchmarkEvidence(evidence, options = {}) {
  if (evidence?.schema !== INTEGRATED_BENCHMARK_SCHEMA) {
    throw new Error(
      `Evidence schema ${JSON.stringify(evidence?.schema)} is not foreground-latency benchmark evidence (${INTEGRATED_BENCHMARK_SCHEMA}).`
    );
  }
  if (
    evidence.metrics?.hostRunAdmission?.operation !== 'main-host-run-start-admission-ack' ||
    evidence.metrics?.toolRead?.operation !== 'shared-file-read-and-authorized-native-grep'
  ) {
    throw new Error(
      'Evidence does not measure current host admission and authorized native grep; legacy DB timings are not comparable.'
    );
  }
  if (evidence.status !== 'valid') {
    const reasons = Array.isArray(evidence.invalidReasons) ? evidence.invalidReasons : [];
    throw new Error(
      `Foreground latency benchmark run is ${evidence.status}: ${reasons.join('; ') || 'no reason recorded'}`
    );
  }
  const configuredDevice = evidence.config?.device;
  const actualDevice = evidence.build?.actualDevice;
  if (
    options.requireDevice &&
    (configuredDevice !== options.requireDevice || actualDevice !== options.requireDevice)
  ) {
    throw new Error(
      `Foreground latency benchmark evidence requires device ${options.requireDevice}, but the run was configured for ${configuredDevice} and embedded on ${actualDevice}.`
    );
  }
  const { rawSamplesMs: _rawSamplesMs, ...summary } = evidence;
  return summary;
}

/** The environment the integrated benchmark spec reads its configuration from. */
export function integratedBenchmarkEnv(options, evidencePath, baseEnv = process.env) {
  return {
    ...baseEnv,
    BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_EVIDENCE_PATH: evidencePath,
    ...(options.requireDevice
      ? { BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_DEVICE: options.requireDevice }
      : {}),
    ...(options.files
      ? { BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_FILES: String(options.files) }
      : {}),
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    evidencePath: null,
    files: null,
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
    } else if (arg === '--files') {
      const files = Number(next());
      if (!Number.isInteger(files) || files <= 0) {
        throw new Error('--files requires a positive integer');
      }
      options.files = files;
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
      if (!(key && Number.isFinite(value)) || value <= 0) {
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

function getStageBenchmarkModes(options) {
  return options.modes.filter((mode) => mode !== 'integrated');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // `streamToStderr` shows a long run's progress while keeping this script's
    // stdout for its JSON result.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: options.streamToStderr ? ['ignore', 2, 2] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
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
    if (!STAGE_BENCHMARK_MODES.has(mode)) {
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
          BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_CHUNKS: String(
            options.stageBenchmarkChunkCount ?? 512
          ),
          BRAINSTRIKE_WORKSPACE_INDEX_STAGE_BENCHMARK_DIMENSIONS: String(
            options.stageBenchmarkDimensions ?? 384
          ),
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

/**
 * Runs the integrated benchmark: a full Workspace Index build of the seeded
 * corpus with foreground latency probes, through the same lane script CI runs.
 */
export async function runIntegratedBenchmark(options) {
  const configuredPath =
    process.env.BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_EVIDENCE_PATH?.trim();
  // Absolute, because the lane runs from apps/desktop while this script reads from its own cwd.
  const evidencePath = configuredPath
    ? path.resolve(configuredPath)
    : path.join(
        await mkdtemp(path.join(os.tmpdir(), 'brainstrike-integrated-benchmark-')),
        'foreground-latency-under-index-build.json'
      );
  await runCommand('pnpm', ['--dir', DESKTOP_APP_ROOT, 'run', INTEGRATED_BENCHMARK_LANE], {
    cwd: REPO_ROOT,
    env: integratedBenchmarkEnv(options, evidencePath),
    streamToStderr: true,
  });
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  return { evidencePath, ...summarizeIntegratedBenchmarkEvidence(evidence, options) };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      [
        'Usage: node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs [--mode <mode>]... [options]',
        '',
        '  --mode integrated (default)  Run the loaded foreground-latency benchmark: a full Workspace',
        '                               Index build of the seeded corpus (--require-device webgpu|wasm,',
        '                               --files <n>). With --evidence, analyze that file instead.',
        '  --mode <stage>-ceiling       Run an Electron stage benchmark.',
        '  --evidence <path>            Analyze recorded evidence: integrated benchmark evidence, or a',
        '                               full-workspace-index-evidence.json from the full-run verifier.',
        '  --stage-ceiling key=value    Stage ceilings for the full-run throughput ratio.',
      ].join('\n')
    );
    return;
  }
  const stageBenchmarks = await runElectronStageBenchmarks(options);
  let result = null;
  if (options.modes.includes('integrated')) {
    if (options.evidencePath) {
      const evidence = JSON.parse(await readFile(options.evidencePath, 'utf8'));
      result = {
        evidencePath: options.evidencePath,
        ...(typeof evidence?.schema === 'string' &&
        evidence.schema.startsWith('brainstrike.foreground-latency-under-index-build.')
          ? summarizeIntegratedBenchmarkEvidence(evidence, options)
          : analyzeWorkspaceIndexEvidence(evidence, options)),
      };
    } else {
      result = await runIntegratedBenchmark(options);
    }
  }
  console.log(JSON.stringify({ ...(result ?? {}), stageBenchmarks }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
