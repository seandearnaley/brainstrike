#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BST372_HISTORICAL_SOURCE_BINDINGS,
  verifyHistoricalSourceBinding,
} from './bst-372-source-binding.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const fixturePath = join(import.meta.dirname, 'bst-372-memory.measurement.spec.ts.fixture');
const configPath = join(import.meta.dirname, 'vitest.bst-372.config.mts');
const bindingPath = join(import.meta.dirname, 'bst-372-source-binding.mjs');
const runnerPath = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve('vitest/package.json');
const vitestCliPath = join(dirname(vitestPackagePath), 'vitest.mjs');

function parseRuns(args) {
  if (args.length !== 2 || args[0] !== '--runs') {
    throw new Error('Usage: node run-bst-372-memory.mjs --runs <positive integer>');
  }
  const runs = Number(args[1]);
  if (!(Number.isSafeInteger(runs) && runs > 0)) {
    throw new Error('BST-372 measurement run count must be a positive safe integer.');
  }
  return runs;
}

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertRepositoryRoot() {
  const actualRoot = runGit(['rev-parse', '--show-toplevel']);
  if (actualRoot !== repositoryRoot) {
    throw new Error(
      `BST-372 runner resolved repository root ${repositoryRoot}, but Git reported ${actualRoot}.`
    );
  }
}

function verifyRevisionObjects(variant) {
  const binding = BST372_HISTORICAL_SOURCE_BINDINGS[variant];
  for (const [relativePath, expectedBlob] of Object.entries(binding.sourceBlobs)) {
    const revisionPath = `${binding.commit}:packages/embedding-worker/${relativePath}`;
    let actualBlob;
    try {
      actualBlob = runGit(['rev-parse', revisionPath]);
    } catch (error) {
      throw new Error(
        `BST-372 cannot resolve ${revisionPath}. Fetch the repository's historical commits before replaying the benchmark.`,
        { cause: error }
      );
    }
    if (actualBlob !== expectedBlob) {
      throw new Error(
        `BST-372 Git object mismatch for ${revisionPath}: expected ${expectedBlob}, received ${actualBlob}. Refusing to measure.`
      );
    }
  }
}

function createArchiveTree(variant, measurementRoot) {
  const binding = BST372_HISTORICAL_SOURCE_BINDINGS[variant];
  verifyRevisionObjects(variant);

  const archiveRoot = join(measurementRoot, variant);
  mkdirSync(archiveRoot, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', binding.commit], {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', archiveRoot], {
    input: archive,
    maxBuffer: 64 * 1024 * 1024,
  });

  const archivedPackageRoot = join(archiveRoot, 'packages/embedding-worker');
  const archivedBenchRoot = join(archivedPackageRoot, 'bench');
  const archivedTestRoot = join(archivedPackageRoot, 'test');
  mkdirSync(archivedBenchRoot, { recursive: true });
  mkdirSync(archivedTestRoot, { recursive: true });
  copyFileSync(bindingPath, join(archivedBenchRoot, 'bst-372-source-binding.mjs'));
  copyFileSync(fixturePath, join(archivedTestRoot, 'bst-372-memory.measurement.spec.ts'));
  copyFileSync(configPath, join(archivedPackageRoot, 'vitest.bst372.config.mts'));

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(join(repositoryRoot, 'node_modules'), join(archiveRoot, 'node_modules'), symlinkType);
  symlinkSync(
    join(packageRoot, 'node_modules'),
    join(archivedPackageRoot, 'node_modules'),
    symlinkType
  );

  const sourceBinding = verifyHistoricalSourceBinding({
    packageRoot: archivedPackageRoot,
    variant,
  });
  return { archivedPackageRoot, sourceBinding };
}

function withExposedGarbageCollection(nodeOptions) {
  const existing = nodeOptions?.trim();
  if (!existing) {
    return '--expose-gc';
  }
  if (/(?:^|\s)--expose-gc(?:\s|$)/.test(existing)) {
    return existing;
  }
  return `${existing} --expose-gc`;
}

function parseMeasurement(stdout) {
  const prefix = 'BST372_MEMORY_RESULT ';
  const resultLines = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (resultLines.length !== 1) {
    throw new Error(
      `Expected exactly one BST372_MEMORY_RESULT line, received ${resultLines.length}.`
    );
  }
  return JSON.parse(resultLines[0]);
}

function assertMeasurementBinding(measurement, sourceBinding) {
  if (
    measurement.variant !== sourceBinding.variant ||
    measurement.implementationCommit !== sourceBinding.commit ||
    JSON.stringify(measurement.sourceBlobs) !== JSON.stringify(sourceBinding.sourceBlobs)
  ) {
    throw new Error('BST-372 child measurement metadata does not match its verified source tree.');
  }
}

function measureFreshProcess({ archivedPackageRoot, sourceBinding }) {
  const environmentWithoutCommit = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'BST372_COMMIT')
  );
  const childEnvironment = {
    ...environmentWithoutCommit,
    ['BST372_VARIANT']: sourceBinding.variant,
    ['FORCE_COLOR']: '0',
    ['NODE_OPTIONS']: withExposedGarbageCollection(process.env['NODE_OPTIONS']),
  };

  const child = spawnSync(
    process.execPath,
    [
      vitestCliPath,
      'run',
      '--config',
      'vitest.bst372.config.mts',
      '--pool=forks',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=verbose',
    ],
    {
      cwd: archivedPackageRoot,
      encoding: 'utf8',
      env: childEnvironment,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    }
  );
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(
      `BST-372 ${sourceBinding.variant} measurement exited with status ${String(child.status)}.`
    );
  }
  const measurement = parseMeasurement(child.stdout ?? '');
  assertMeasurementBinding(measurement, sourceBinding);
  return measurement;
}

function main() {
  const runs = parseRuns(process.argv.slice(2));
  assertRepositoryRoot();
  const measurementRoot = mkdtempSync(join(tmpdir(), 'bst372-memory-'));
  try {
    const trees = {
      'pre-stream': createArchiveTree('pre-stream', measurementRoot),
      stream: createArchiveTree('stream', measurementRoot),
    };
    const verifiedResults = [];
    for (let run = 1; run <= runs; run += 1) {
      const order = run % 2 === 1 ? ['pre-stream', 'stream'] : ['stream', 'pre-stream'];
      for (const variant of order) {
        const measurement = measureFreshProcess(trees[variant]);
        const verifiedResult = { ...measurement, run };
        verifiedResults.push(verifiedResult);
        process.stdout.write(`BST372_VERIFIED_MEMORY_RESULT ${JSON.stringify(verifiedResult)}\n`);
      }
    }

    process.stdout.write(
      `BST372_MEMORY_RUNNER_SUMMARY ${JSON.stringify({
        artifacts: {
          bindingSha256: sha256(bindingPath),
          configSha256: sha256(configPath),
          fixtureSha256: sha256(fixturePath),
          runnerSha256: sha256(runnerPath),
        },
        results: verifiedResults,
        runs,
      })}\n`
    );
  } finally {
    rmSync(measurementRoot, { force: true, recursive: true });
  }
}

main();
