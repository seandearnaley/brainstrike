// @vitest-environment node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { resolveMainWatchdogWorkerPath } from '../../diagnostics/main-watchdog-path';

const execFileAsync = promisify(execFile);

const PRODUCTION_CHECK_INTERVAL = 'export const MAIN_WATCHDOG_CHECK_INTERVAL_MS = 5000;';
const PRODUCTION_CHECK_DISCONTINUITY =
  'export const MAIN_WATCHDOG_CHECK_DISCONTINUITY_MS = MAIN_WATCHDOG_CHECK_INTERVAL_MS * 2;';
const PRODUCTION_FROZEN_THRESHOLD = 'export const MAIN_WATCHDOG_FROZEN_THRESHOLD_MS = 20_000;';

async function buildAcceleratedWatchdogWorker(outputPath: string): Promise<void> {
  const corePath = path.resolve(import.meta.dirname, '../../diagnostics/main-watchdog-core.ts');
  const workerPath = path.resolve(import.meta.dirname, '../../diagnostics/main-watchdog-worker.ts');

  await esbuild.build({
    bundle: true,
    entryPoints: [workerPath],
    format: 'cjs',
    outfile: outputPath,
    platform: 'node',
    plugins: [
      {
        name: 'accelerate-main-watchdog-for-test',
        setup(build) {
          build.onLoad({ filter: /main-watchdog-core\.ts$/ }, async (args) => {
            if (path.resolve(args.path) !== corePath) {
              return;
            }

            const productionSource = await fs.readFile(corePath, 'utf8');
            if (
              !(
                productionSource.includes(PRODUCTION_CHECK_INTERVAL) &&
                productionSource.includes(PRODUCTION_CHECK_DISCONTINUITY) &&
                productionSource.includes(PRODUCTION_FROZEN_THRESHOLD)
              )
            ) {
              throw new Error(
                'Main watchdog integration test could not find the production timing constants'
              );
            }

            return {
              contents: productionSource
                .replace(
                  PRODUCTION_CHECK_INTERVAL,
                  'export const MAIN_WATCHDOG_CHECK_INTERVAL_MS = 25;'
                )
                .replace(
                  PRODUCTION_CHECK_DISCONTINUITY,
                  'export const MAIN_WATCHDOG_CHECK_DISCONTINUITY_MS = 2_000;'
                )
                .replace(
                  PRODUCTION_FROZEN_THRESHOLD,
                  'export const MAIN_WATCHDOG_FROZEN_THRESHOLD_MS = 100;'
                ),
              loader: 'ts',
            };
          });
        },
      },
    ],
    target: 'node24',
  });
}

describe('main watchdog worker stderr', () => {
  it('launches the flat worker path resolved for a directly launched development build', async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-main-watchdog-worker-path-')
    );
    const distDirectory = path.join(temporaryDirectory, 'dist');
    await fs.mkdir(distDirectory);
    const workerPath = path.join(distDirectory, 'main-watchdog-worker.js');
    let worker: Worker | undefined;

    try {
      await buildAcceleratedWatchdogWorker(workerPath);
      const resolvedPath = resolveMainWatchdogWorkerPath(
        distDirectory,
        false,
        path.join(distDirectory, 'main.js')
      );

      worker = new Worker(resolvedPath);
      await new Promise<void>((resolve, reject) => {
        worker?.once('error', reject);
        worker?.once('online', resolve);
      });
    } finally {
      await worker?.terminate();
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('emits a freeze diagnostic before the blocked parent main thread resumes', async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-main-watchdog-worker-')
    );

    try {
      const workerPath = path.join(temporaryDirectory, 'main-watchdog-worker.cjs');
      await buildAcceleratedWatchdogWorker(workerPath);

      const fixturePath = path.resolve(
        import.meta.dirname,
        '../fixtures/run-main-watchdog-blocked-parent.mjs'
      );
      const { stderr } = await execFileAsync(process.execPath, [fixturePath, workerPath], {
        encoding: 'utf8',
        timeout: 5000,
      });

      const parentBlockedIndex = stderr.indexOf('PARENT_MAIN_THREAD_BLOCKED');
      const diagnosticIndex = stderr.indexOf(
        '"msg":"MAIN_THREAD_UNRESPONSIVE"',
        parentBlockedIndex
      );
      const parentUnblockedIndex = stderr.indexOf('PARENT_MAIN_THREAD_UNBLOCKED');

      expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
      expect(parentBlockedIndex).toBeGreaterThanOrEqual(0);
      expect(diagnosticIndex).toBeGreaterThan(parentBlockedIndex);
      expect(parentUnblockedIndex).toBeGreaterThan(diagnosticIndex);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('writes worker failures directly to stderr before the worker exits', async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-main-watchdog-worker-failure-')
    );

    try {
      const workerPath = path.join(temporaryDirectory, 'main-watchdog-worker.cjs');
      await buildAcceleratedWatchdogWorker(workerPath);
      const fixturePath = path.resolve(
        import.meta.dirname,
        '../fixtures/run-main-watchdog-malformed-message.mjs'
      );

      const { stderr } = await execFileAsync(process.execPath, [fixturePath, workerPath], {
        encoding: 'utf8',
        timeout: 5000,
      });

      expect(stderr).toContain('"msg":"MAIN_WATCHDOG_WORKER_FAILED"');
      expect(stderr).toContain('Main watchdog received a malformed message');
      expect(stderr.indexOf('"msg":"MAIN_WATCHDOG_WORKER_FAILED"')).toBeLessThan(
        stderr.indexOf('WATCHDOG_WORKER_EXITED')
      );
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
