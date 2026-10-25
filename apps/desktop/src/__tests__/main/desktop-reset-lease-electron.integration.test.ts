// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    bundle: true,
    entryPoints: {
      'agent-host-entry': 'src/agent-host-entry.ts',
      'agent-host-utility-platform': 'src/__tests__/fixtures/agent-host-utility-platform.ts',
      driver: 'src/__tests__/fixtures/desktop-reset-lease-electron.ts',
    },
    format: 'cjs',
    nodePaths: [resolve('node_modules')],
    outdir: directory,
    // apps/desktop is `type: module`; CommonJS output needs `.cjs`.
    outExtension: { '.js': '.cjs' },
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
    join(directory, 'driver.cjs'),
    userData,
    join(directory, 'agent-host-entry.cjs'),
    join(directory, 'agent-host-utility-platform.cjs'),
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
  it.each(['success', 'storage-failure'])(
    'joins the actual native utility and protects profile ancestry through %s',
    async (mode) => {
      const { profile, report } = await run(mode);
      expect(report.result).toEqual({ success: true });
      expect(report.events.indexOf('native-stop')).toBeLessThan(report.events.indexOf('guard'));
      expect(report.events.indexOf('profile')).toBeLessThan(report.events.indexOf('storage'));
      expect(report.events.indexOf('storage')).toBeLessThan(report.events.indexOf('renderer'));
      expect(processStartTime(report.nativePid)).not.toBe(report.nativeStart);
      expect(RootLock.inspect(profile)?.owner.released).toBe(true);
      if (mode === 'storage-failure') {
        expect(report.first).toEqual({
          message: 'Injected Electron storage failure',
          success: false,
        });
        expect(report.retained).toBe(true);
        expect(report.events.filter((event) => event === 'guard')).toHaveLength(1);
        expect(report.events.filter((event) => event === 'profile')).toHaveLength(2);
      }
      const contender = await RootLock.acquire(profile);
      contender.release();
    },
    60_000
  );

  it('refuses a live external Root owner before any profile/userData deletion and leaves it holding', async () => {
    const profile = join(directory, 'external-owner', 'data', 'profiles', 'default');
    await mkdir(profile, { recursive: true });
    // This test process is the external owner: the app's reset must refuse it, not take it.
    const owner = await RootLock.acquire(profile);
    try {
      const { report } = await run('external-owner');
      expect(report.result.success).toBe(false);
      expect(report.retained).toBe(false);
      expect(report.events).not.toContain('profile');
      expect(report.events).not.toContain('storage');
      expect(owner.isReleased).toBe(false);
      expect(await readFile(join(profile, 'state.db'), 'utf8')).toBe('state payload');
    } finally {
      owner.release();
    }
  }, 60_000);
});
