/**
 * Real PGlite hybrid-search benchmark (BST-270).
 *
 * Run from packages/db:
 *   pnpm bench:hybrid-search
 *   pnpm bench:hybrid-search -- --rows 10000 --dimensions 384 --json /tmp/hybrid.json
 *
 * This is deliberately a manual, uncached benchmark. Unit tests pin the
 * deterministic reporting contract; the integration test runs a small real
 * corpus; this CLI owns the retained 10k+ performance evidence.
 */

import { writeFileSync } from 'node:fs';

interface BenchmarkCliOptions {
  readonly dimensions: number;
  readonly iterations: number;
  readonly jsonPath: string | null;
  readonly limit: number;
  readonly rows: number;
  readonly topics: number;
  readonly warmupIterations: number;
}

const DEFAULT_OPTIONS: BenchmarkCliOptions = {
  dimensions: 384,
  iterations: 24,
  jsonPath: null,
  limit: 10,
  rows: 10_000,
  topics: 8,
  warmupIterations: 3,
};

const VALUE_FLAGS = new Set([
  '--dimensions',
  '--iterations',
  '--json',
  '--limit',
  '--rows',
  '--topics',
  '--warmup',
]);

function parseInteger(rawValue: string, label: string, allowZero = false): number {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  const value = Number(rawValue);
  if (!(Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0))) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return value;
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!(typeof value === 'string' && value.length > 0 && !value.startsWith('--'))) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(args: readonly string[]): BenchmarkCliOptions {
  let options = { ...DEFAULT_OPTIONS };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!(typeof flag === 'string' && VALUE_FLAGS.has(flag))) {
      throw new Error(`Unsupported hybrid benchmark argument: ${String(flag)}`);
    }
    const value = readFlagValue(args, index, flag);
    switch (flag) {
      case '--dimensions':
        options = { ...options, dimensions: parseInteger(value, flag) };
        break;
      case '--iterations':
        options = { ...options, iterations: parseInteger(value, flag) };
        break;
      case '--json':
        options = { ...options, jsonPath: value };
        break;
      case '--limit':
        options = { ...options, limit: parseInteger(value, flag) };
        break;
      case '--rows':
        options = { ...options, rows: parseInteger(value, flag) };
        break;
      case '--topics':
        options = { ...options, topics: parseInteger(value, flag) };
        break;
      case '--warmup':
        options = { ...options, warmupIterations: parseInteger(value, flag, true) };
        break;
      default:
        throw new Error(`Unhandled hybrid benchmark argument: ${flag}`);
    }
  }
  return options;
}

const processArgs = process.argv.slice(2);
const cli = parseArgs(processArgs[0] === '--' ? processArgs.slice(1) : processArgs);

// Keep stdout machine-readable and stop the benchmark corpus from producing
// ordinary repository logs. Failures still surface through the thrown error or
// report.failures.
process.env['LOG_LEVEL'] = 'silent';
const { runPGliteHybridSearchBenchmark } = await import(
  '../src/search/pglite-hybrid-search-benchmark.js'
);

const report = await runPGliteHybridSearchBenchmark({
  dimensions: cli.dimensions,
  iterations: cli.iterations,
  limit: cli.limit,
  rows: cli.rows,
  thresholds: {
    maxAdditionalP95Ms: 100,
    maxHybridP95Ms: 500,
  },
  topics: cli.topics,
  warmupIterations: cli.warmupIterations,
});
const artifact = {
  ...report,
  environment: {
    arch: process.arch,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
  },
};
const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
if (cli.jsonPath) {
  writeFileSync(cli.jsonPath, serialized, 'utf8');
}
process.stdout.write(serialized);
if (!report.passed) {
  process.exitCode = 1;
}
