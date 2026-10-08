import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { build } from 'tsup';
import { expect, test } from 'vitest';

function execute(args: readonly string[], signal: AbortSignal): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failure: unknown;
    const stop = () => {
      if (!child.kill('SIGTERM')) {
        failure = new Error('Could not stop the owned native TEXT fixture process.');
      }
    };
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    child.on('error', (cause) => {
      failure = cause;
    });
    signal.addEventListener('abort', stop, { once: true });
    child.once('close', (code) => {
      signal.removeEventListener('abort', stop);
      if (failure !== undefined) {
        reject(failure);
      } else if (code !== 0) {
        reject(
          new Error(`Native TEXT fixture exited ${code}: ${stderr}\n${stdout}`, {
            cause: signal.aborted ? signal.reason : undefined,
          })
        );
      } else if (signal.aborted) {
        reject(signal.reason);
      } else {
        resolve({ stdout });
      }
    });
    if (signal.aborted) {
      stop();
    }
  });
}
const driver = path.join(import.meta.dirname, 'fixtures/node-native-text-services.mjs');
const desktop = path.resolve(import.meta.dirname, '../../../../apps/desktop/src');
const captured = path.resolve(
  import.meta.dirname,
  '../../../indexer/__tests__/fixtures/canonical-provided-chunks.json'
);

for (const mode of ['provenance', 'stop', 'query']) {
  test(`public plain Node TEXT borrows real native SQLite authority: ${mode}`, async (testContext) => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'bs-node-native-text-'));
    const ownerBundles = await mkdtemp(path.join(path.dirname(driver), '.m3-native-text-'));
    try {
      const entries = [
        'native-index-runtime',
        'native-index-read-authority',
        'native-index-settings',
        'native-canonical-publication',
        'native-authority-transition',
        'native-coverage-observation-invalidated',
        'native-index-blocked',
        'native-index-setup-required',
        'native-index-search',
        'native-scoped-search',
      ];
      await build({
        bundle: true,
        clean: false,
        dts: false,
        entry: Object.fromEntries(entries.map((name) => [name, path.join(desktop, `${name}.ts`)])),
        external: [/^@brainstrike\//],
        format: ['esm'],
        outDir: ownerBundles,
        silent: true,
        splitting: false,
      });
      const seeded = await execute(
        [driver, 'seed', fixture, captured, ownerBundles],
        testContext.signal
      );
      expect(JSON.parse(seeded.stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
        electron: false,
        seeded: true,
      });
      const result = await execute(
        [driver, mode, fixture, captured, ownerBundles],
        testContext.signal
      );
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
        constructorIdentity: true,
        electron: false,
        joined: true,
        mode,
        sameLease: true,
        ...(mode === 'stop'
          ? { noLatePublication: true, stopJoined: true }
          : {
              authorizedBeforeRanking: true,
              ...(mode === 'query' ? { cleanupFailureVisible: true } : {}),
              exactProvenance: true,
              partialCoverage: true,
              reopened: true,
              revokedRefused: true,
              savedChoiceDriftRefused: true,
            }),
      });
    } finally {
      const owner = RootLock.inspect(path.join(fixture, 'profiles', 'selected'));
      // Failed joins retain their physical evidence and are never retried by fixture cleanup.
      if (!owner || owner.owner.released) {
        await rm(fixture, { force: true, recursive: true });
        await rm(ownerBundles, { force: true, recursive: true });
      } else {
        await rename(ownerBundles, path.join(fixture, 'retained-owner-bundles'));
      }
    }
  }, 60_000);
}
