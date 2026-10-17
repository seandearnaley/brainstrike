#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DESKTOP_APP_ROOT, '../..');
const INTEGRATED_BENCHMARK_LANE = 'test:e2e:lane:foreground-latency';
const INTEGRATED_BENCHMARK_SCHEMA = 'brainstrike.foreground-latency-under-index-build.v3';

const FULL_RUN_SCHEMA = 'brainstrike.full-workspace-index.v2';

function maxOf(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return finite.length === 0 ? null : Math.max(...finite);
}

function roundMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

/** Every configured root scanned to completion, and every chunk embedded. */
function isTerminalIndex(index, rootIds) {
  return (
    index?.status === 'ready' &&
    rootIds.length > 0 &&
    Array.isArray(index.roots) &&
    index.roots.length === rootIds.length &&
    rootIds.every((rootId) =>
      index.roots.some((root) => root.rootId === rootId && root.scanComplete === true)
    ) &&
    index.fileCount > 0 &&
    index.chunkCount > 0 &&
    index.embeddedChunkCount === index.chunkCount &&
    index.missingVectors === 0 &&
    index.vectorCoverageComplete === true
  );
}

/**
 * Validates evidence written by e2e/full-workspace-index.desktop.test.ts, the
 * native index's own counts, scan receipts and actual embedding worker, and
 * reports its throughput. An incomplete run, a fatal log line or a run on a
 * device other than the required one is an error.
 */
export function analyzeWorkspaceIndexEvidence(evidence, options = {}) {
  if (evidence?.schema !== FULL_RUN_SCHEMA) {
    throw new Error(
      `Evidence schema ${JSON.stringify(evidence?.schema)} is not full Workspace Index run evidence (${FULL_RUN_SCHEMA}).`
    );
  }
  if (evidence.status !== 'completed') {
    throw new Error(
      `Workspace Index full run ${evidence.status}: ${evidence.error?.message ?? 'no error recorded'}`
    );
  }
  const samples = Array.isArray(evidence.samples) ? evidence.samples : [];
  if (samples.length === 0) {
    throw new Error('Workspace Index evidence contains no samples.');
  }

  const fatalLogMatches = Array.isArray(evidence.fatalLogMatches)
    ? evidence.fatalLogMatches.map(String).filter((value) => value.length > 0)
    : [];
  if (fatalLogMatches.length > 0) {
    throw new Error(`Workspace Index evidence contains fatal log patterns: ${fatalLogMatches[0]}`);
  }

  const finalSample = samples.at(-1);
  const finalIndex = finalSample.index;
  const rootIds = Array.isArray(evidence.roots) ? evidence.roots.map((root) => root?.rootId) : [];
  if (!isTerminalIndex(finalIndex, rootIds)) {
    throw new Error(
      `Workspace Index did not complete its ${rootIds.length} roots: ${JSON.stringify(finalIndex)}`
    );
  }

  const worker = evidence.worker;
  if (!(worker && typeof worker === 'object')) {
    throw new Error('Workspace Index evidence has no actual embedding worker metadata.');
  }
  const requiredDevice = options.requireDevice ?? evidence.requiredDevice;
  if (
    requiredDevice &&
    (worker.device !== requiredDevice || finalIndex.actualDevice !== requiredDevice)
  ) {
    throw new Error(
      `Workspace Index actual embedding backend mismatch: expected ${requiredDevice}, got worker ${worker.device} and query plan ${finalIndex.actualDevice}`
    );
  }
  if (worker.fallbackApplied === true) {
    throw new Error('Workspace Index actual embedding runtime reported fallbackApplied=true.');
  }

  const maxHeapUsedMb = maxOf(samples.map((sample) => sample.memory?.rendererHeapUsedMb));
  if (
    typeof options.maxRetainedHeapMb === 'number' &&
    maxHeapUsedMb !== null &&
    maxHeapUsedMb > options.maxRetainedHeapMb
  ) {
    throw new Error(
      `Workspace Index retained heap exceeded limit: ${roundMetric(maxHeapUsedMb)}MB > ${options.maxRetainedHeapMb}MB`
    );
  }

  const firstProgressIndex = samples.findIndex((sample) => sample.index?.embeddedChunkCount > 0);
  const firstThroughputSample =
    firstProgressIndex > 0 ? samples[firstProgressIndex - 1] : samples[0];
  const elapsedSeconds = Math.max(
    0.001,
    (finalSample.elapsedMs - firstThroughputSample.elapsedMs) / 1000
  );
  const embeddedDelta = Math.max(
    0,
    finalIndex.embeddedChunkCount - (firstThroughputSample.index?.embeddedChunkCount ?? 0)
  );

  return {
    actualWorkerMetadata: worker,
    durationMs: finalSample.elapsedMs - samples[0].elapsedMs,
    finalCounts: {
      chunkCount: finalIndex.chunkCount,
      embeddedChunkCount: finalIndex.embeddedChunkCount,
      fileCount: finalIndex.fileCount,
      roots: finalIndex.roots,
    },
    integratedChunksPerSecond: roundMetric(embeddedDelta / elapsedSeconds),
    maxEmbeddingHostWorkingSetMb: maxOf(
      samples.map((sample) => sample.memory?.embeddingHostWorkingSetMb)
    ),
    maxHeapUsedMb: roundMetric(maxHeapUsedMb),
    queryPlanDevice: finalIndex.actualDevice,
    requiredDevice: requiredDevice ?? null,
    sampleCount: samples.length,
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
    profile: null,
    requireDevice: null,
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
    } else if (arg === '--mode') {
      // The stage benchmark measured retired PGlite stages (BST-2012); the
      // loaded native build is the one mode, kept as a flag for existing callers.
      const mode = next();
      if (mode !== 'integrated') {
        throw new Error(`Unknown benchmark mode: ${mode}. Expected: integrated`);
      }
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
        '  --evidence <path>            Analyze recorded evidence: integrated benchmark evidence, or a',
        '                               full-workspace-index-evidence.json from the full-run verifier.',
      ].join('\n')
    );
    return;
  }
  let result;
  if (options.evidencePath) {
    const evidence = JSON.parse(await readFile(options.evidencePath, 'utf8'));
    result = {
      evidencePath: options.evidencePath,
      ...(evidence?.schema === INTEGRATED_BENCHMARK_SCHEMA
        ? summarizeIntegratedBenchmarkEvidence(evidence, options)
        : analyzeWorkspaceIndexEvidence(evidence, options)),
    };
  } else {
    result = await runIntegratedBenchmark(options);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
