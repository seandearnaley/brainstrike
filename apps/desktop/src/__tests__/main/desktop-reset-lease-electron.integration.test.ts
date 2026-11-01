// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { makeThrowingDecoder, runWithTimeout } from '@brainstrike/effect-kit';
import { createNodeHostSpawner, launchHost } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESM_REQUIRE_BANNER } from '../../../scripts/build-main-config.mjs';

const resultSchema = Schema.Struct({
  message: Schema.optional(Schema.String),
  success: Schema.Boolean,
});
const decodeReport = makeThrowingDecoder(
  Schema.Struct({
    events: Schema.Array(Schema.String),
    first: resultSchema,
    nativePid: Schema.Int,
    nativeStart: Schema.String,
    result: resultSchema,
    retained: Schema.Boolean,
  }),
  { onExcessProperty: 'error' }
);
let directory: string;
beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  directory = await mkdtemp(join(resolve('dist'), 'desktop-reset-proof-'));
  await build({
    absWorkingDir: resolve('.'),
    banner: ESM_REQUIRE_BANNER,
    bundle: true,
    entryPoints: {
      driver: 'src/__tests__/fixtures/desktop-reset-lease-electron.ts',
      'host-lease-entry': 'src/host-lease-entry.ts',
    },
    format: 'esm',
    nodePaths: [resolve('node_modules')],
    outdir: directory,
    packages: 'external',
    platform: 'node',
    target: 'node24',
    tsconfigRaw: '{}',
  });
}, 30_000);
afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function run(mode: string) {
  const userData = join(directory, mode);
  await mkdir(userData, { recursive: true });
  const executable: unknown = createRequire(import.meta.url)('electron');
  if (typeof executable !== 'string') {
    throw new TypeError('Electron executable path is unavailable');
  }
  const env = {
    ...process.env,
    BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
    NODE_PATH: resolve('node_modules'),
  };
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE');
  const args = [
    join(directory, 'driver.js'),
    userData,
    join(directory, 'host-lease-entry.js'),
    mode,
  ];
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    args.push('--no-sandbox');
  }
  const { stdout } = await promisify(execFile)(executable, args, {
    env,
    maxBuffer: 10_000_000,
    timeout: 45_000,
  }).catch((cause: unknown) => {
    // A failed or timed-out driver's own output is the only record of where it stopped.
    const output = cause as { stderr?: unknown; stdout?: unknown };
    throw new Error(
      `Electron reset driver failed (${mode}).\nstdout:\n${String(output.stdout)}\nstderr:\n${String(output.stderr)}`,
      { cause }
    );
  });
  const report = stdout.split('\n').find((line) => line.startsWith('RESET_ADAPTER_PROOF '));
  if (!report) {
    throw new Error(`Electron reset did not report a result: ${stdout}`);
  }
  return {
    profile: join(userData, 'data', 'profiles', 'default'),
    report: decodeReport(JSON.parse(report.slice('RESET_ADAPTER_PROOF '.length))),
  };
}

describe('real Electron desktop reset lease adapter', () => {
  it('joins the actual native utility and protects profile ancestry through a reset', async () => {
    const { profile, report } = await run('success');
    expect(report.result).toEqual({ success: true });
    expect(report.events.indexOf('native-stop')).toBeLessThan(report.events.indexOf('guard'));
    expect(report.events.indexOf('profile')).toBeLessThan(report.events.indexOf('renderer'));
    expect(processStartTime(report.nativePid)).not.toBe(report.nativeStart);
    expect(RootLock.inspect(profile)?.owner.released).toBe(true);
    const contender = await RootLock.acquire(profile);
    contender.release();
  }, 60_000);

  it('refuses an actual live CLI owner before any profile/userData deletion and never kills it', async () => {
    const profile = join(directory, 'external-cli', 'data', 'profiles', 'default');
    const cli = await launchHost(profile, {
      lifetime: 'persistent',
      spawn: createNodeHostSpawner({
        entrypoint: resolve('../../packages/host-lease/src/process-entry.ts'),
      }),
    });
    const before = await readFile(join(profile, 'host.json'), 'utf8');
    try {
      const { report } = await run('external-cli');
      expect(report.result.success).toBe(false);
      expect(report.retained).toBe(false);
      expect(report.events).not.toContain('profile');
      expect(report.events).not.toContain('renderer');
      expect(processStartTime(cli.record.pid)).toBe(cli.record.start);
      expect(await readFile(join(profile, 'host.json'), 'utf8')).toBe(before);
      expect(await readFile(join(profile, 'state.db'), 'utf8')).toBe('state payload');
    } finally {
      await cli.close();
      // Only this harness's own persistent CLI child is terminated for cleanup.
      if (processStartTime(cli.record.pid) === cli.record.start) {
        process.kill(cli.record.pid, 'SIGTERM');
      }
      await runWithTimeout(
        async (signal) => {
          while (processStartTime(cli.record.pid) === cli.record.start) {
            signal.throwIfAborted();
            await new Promise<void>((complete) => setTimeout(complete, 20));
          }
        },
        { onTimeout: () => new Error('Test CLI did not exit'), timeoutMs: 5000 }
      );
    }
  }, 60_000);
});
