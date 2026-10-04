// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { _electron } from '@playwright/test';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import { readNativeObservation, readNativeSnapshot } from '../../qualification/m2-native/candidate';
import { observeCoverage } from '../../qualification/m2-native/coverage-observation';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';

it('carries real fenced invalidation data through sandboxed production preload and Playwright', async () => {
  await mkdir(path.resolve('dist'), { recursive: true });
  const directory = await mkdtemp(path.join(path.resolve('dist'), 'coverage-transport-proof-'));
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let child: ReturnType<NonNullable<typeof application>['process']> | undefined;
  let ownedPids: number[] = [];
  const nativeSource = process.env['BRAINSTRIKE_COVERAGE_PROOF_NATIVE_SOURCE'];
  try {
    await build({
      ...MAIN_PROCESS_BUILD_OPTIONS,
      entryPoints: {
        driver: 'src/__tests__/fixtures/coverage-observation-electron.ts',
        preload: 'src/preload.ts',
      },
      outdir: directory,
      plugins: nativeSource
        ? [
            {
              name: 'coverage-proof-native-source',
              setup: (builder) => {
                builder.onLoad(
                  {
                    // esbuild uses Go regex syntax and rejects the JavaScript u flag.
                    filter: /\/native-scoped-search\.ts$/,
                  },
                  async () => ({
                    contents: await readFile(nativeSource, 'utf8'),
                    loader: 'ts',
                    resolveDir: path.resolve('src'),
                  })
                );
              },
            },
          ]
        : [],
    });
    const document = path.join(directory, 'index.html');
    await writeFile(document, '<!doctype html><title>Coverage transport control</title>');
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') {
      throw new Error('Electron executable is required.');
    }
    const environment = {
      ...process.env,
      BRAINSTRIKE_COVERAGE_PROOF_DOCUMENT: document,
      BRAINSTRIKE_COVERAGE_PROOF_PRELOAD: path.join(directory, 'preload.js'),
      BRAINSTRIKE_COVERAGE_PROOF_PROFILE: path.join(directory, 'user-data'),
    };
    Reflect.deleteProperty(environment, 'ELECTRON_RUN_AS_NODE');
    application = await _electron.launch({
      args: [path.join(directory, 'driver.js')],
      cwd: path.resolve('.'),
      env: environment,
      executablePath: executable,
      timeout: 20_000,
    });
    child = application.process();
    const page = await application.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const context = { app: application, window: page } as unknown as ElectronAppContext;
    const records: unknown[] = [];
    const record = async (phase: string, value: unknown): Promise<void> => {
      records.push({ phase, value });
    };
    console.log(
      'COVERAGE_TRANSPORT_TARGET',
      JSON.stringify({
        nativeSource: process.env['BRAINSTRIKE_COVERAGE_PROOF_NATIVE_SOURCE'] ?? 'current',
      })
    );
    const rejected = await observeCoverage(() => readNativeObservation(context), record);
    expect(rejected).toEqual({
      code: 'native-coverage-observation-invalidated',
      kind: 'invalidated',
    });
    expect(rejected).not.toHaveProperty('status');
    expect(rejected).not.toHaveProperty('coverage');
    expect(records).toHaveLength(1);
    const fresh = await observeCoverage(() => readNativeObservation(context), record);
    if (fresh.kind !== 'current') {
      throw new Error('Expected a wholly new current observation.');
    }
    expect(fresh.value.coverage?.totals.indexedFiles).toBe(1);
    await expect(readNativeSnapshot(context)).rejects.toMatchObject({
      code: 'native-coverage-observation-invalidated',
    });
    const publicBatch = await page.evaluate(async () => {
      const api = window as typeof window & { indexSearch: IndexSearchCapability };
      return await api.indexSearch.coverageBatch([{ rootIds: ['root'] }]);
    });
    expect(publicBatch.kind).toBe('current');
    await expect(observeCoverage(() => readNativeObservation(context), record)).rejects.toThrow(
      'Native source or saved profile changed during search.'
    );
    expect(records).toHaveLength(1);
    await expect(
      page.evaluate(async () => {
        const api = window as typeof window & { indexSearch: IndexSearchCapability };
        return await api.indexSearch.coverage({ rootIds: ['root'] });
      })
    ).rejects.toThrow('Native source or saved profile changed during search.');
    const preferences = await application.evaluate(({ BrowserWindow: Window }) => {
      // Electron 44.4.5 exposes this getter at runtime (proved by the native control),
      // while its public declarations omit it. This assertion is fixture-only.
      const contents = Window.getAllWindows()[0]?.webContents as unknown as
        | { getLastWebPreferences(): Electron.WebPreferences }
        | undefined;
      return contents?.getLastWebPreferences();
    });
    expect(preferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    console.log(
      'COVERAGE_TRANSPORT_PROOF',
      JSON.stringify({
        fresh,
        preferences: {
          contextIsolation: preferences?.contextIsolation,
          nodeIntegration: preferences?.nodeIntegration,
          sandbox: preferences?.sandbox,
        },
        publicBatch,
        records,
        rejected,
      })
    );
  } finally {
    if (application) {
      ownedPids = await application.evaluate(({ app }) =>
        app.getAppMetrics().map(({ pid }) => pid)
      );
    }
    await application?.close();
    if (child) {
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    }
    await expect
      .poll(
        () =>
          ownedPids.filter((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (error) {
              if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
                return false;
              }
              throw error;
            }
          }),
        { interval: 50, timeout: 5000 }
      )
      .toEqual([]);
    console.log(
      'COVERAGE_TRANSPORT_CLEANUP',
      JSON.stringify({ exitCode: child?.exitCode, ownedPids, signal: child?.signalCode })
    );
    await rm(directory, { force: true, recursive: true });
  }
}, 45_000);
