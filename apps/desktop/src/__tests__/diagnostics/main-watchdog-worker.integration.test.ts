// @vitest-environment node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const PRODUCTION_CHECK_INTERVAL = 'export const MAIN_WATCHDOG_CHECK_INTERVAL_MS = 5000;';
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

      const diagnosticIndex = stderr.indexOf('"msg":"MAIN_THREAD_UNRESPONSIVE"');
      const parentUnblockedIndex = stderr.indexOf('PARENT_MAIN_THREAD_UNBLOCKED');

      expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
      expect(parentUnblockedIndex).toBeGreaterThan(diagnosticIndex);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
