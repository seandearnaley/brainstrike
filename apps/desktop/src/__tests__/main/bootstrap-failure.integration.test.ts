// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { build } from 'esbuild';
import { _electron } from 'playwright';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_HOST_PLATFORM_BUILD_OPTIONS,
  MAIN_PROCESS_BUILD_OPTIONS,
  MAIN_PROCESS_ENTRY_POINTS,
} from '../../../scripts/build-main-config.mjs';

import { createDisposableAppProfile } from '../helpers/disposable-app-profile';
import { electronSessionEnvironment } from '../helpers/electron-executable';

const ReportSchema = z.object({ detail: z.unknown(), event: z.string() });

it('forks before full Main evaluation and physically joins the utility if Main binding fails', async () => {
  const desktop = resolve(import.meta.dirname, '../../..');
  await mkdir(join(desktop, 'dist'), { recursive: true });
  const directory = await mkdtemp(join(desktop, 'dist/bootstrap-failure-proof-'));
  const userData = join(directory, 'profile');
  const home = join(directory, 'home');
  await mkdir(home);
  const names = new Set([
    'main',
    'desktop-bootstrap-runtime',
    'desktop-database-location',
    'desktop-env',
    'desktop-shutdown-state',
    'agent-host-entry',
  ]);
  try {
    await build({
      ...MAIN_PROCESS_BUILD_OPTIONS,
      entryPoints: {
        ...Object.fromEntries(
          Object.entries(MAIN_PROCESS_ENTRY_POINTS).filter(([name]) => names.has(name))
        ),
        driver: 'src/__tests__/fixtures/bootstrap-failure-electron.ts',
      },
      logLevel: 'silent',
      outdir: directory,
    });
    await build({ ...AGENT_HOST_PLATFORM_BUILD_OPTIONS, logLevel: 'silent', outdir: directory });
    // Inject failure exactly at the emitted full Main boundary, after real fork.
    await writeFile(
      join(directory, 'main-runtime.js'),
      `process.stdout.write(JSON.stringify({ event: 'main-evaluation', detail: null }) + '\\n'); throw new Error('Injected Main binding failure');\n`
    );
    const electron: unknown = createRequire(import.meta.url)('electron');
    if (typeof electron !== 'string') {
      throw new Error('Missing Electron executable');
    }
    const result = await new Promise<{
      code: number | string | null | undefined;
      stdout: string;
      stderr: string;
    }>((done) => {
      execFile(
        electron,
        [join(directory, 'driver.js'), '--test-mode', `--user-data-dir=${userData}`],
        {
          cwd: desktop,
          env: {
            ...electronSessionEnvironment(),
            BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
            BRAINSTRIKE_E2E_USER_DATA_DIR: userData,
            ELECTRON_IS_E2E_TEST: 'true',
            HOME: home,
            MASTRA_TELEMETRY_DISABLED: 'true',
            NODE_ENV: 'test',
            PATH: process.env['PATH'],
          },
          timeout: 15_000,
        },
        (error, stdout, stderr) => done({ code: error?.code, stderr, stdout })
      );
    });
    const reports = result.stdout.split('\n').flatMap((line) => {
      if (!line.startsWith('{')) {
        return [];
      }
      const parsed = ReportSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    });
    const events = reports.map(({ event }) => event);
    expect(result.code, result.stderr).toBe(1);
    expect(events).toContain('fork');
    expect(events).toContain('main-evaluation');
    expect(events.indexOf('fork')).toBeLessThan(events.indexOf('main-evaluation'));
    expect(events).toContain('utility-exit');
    expect(events.indexOf('utility-exit')).toBeLessThan(events.indexOf('app-exit'));
    expect(reports.find(({ event }) => event === 'failure')?.detail).toContain(
      'Injected Main binding failure'
    );
    const pid = z.number().parse(reports.find(({ event }) => event === 'spawn')?.detail);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(RootLock.inspect(join(userData, 'profiles/test'))?.owner.released ?? true).toBe(true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

it('joins quit during the initial window load without opening a startup-failure dialog', async () => {
  const desktop = resolve(import.meta.dirname, '../../..');
  const { root } = await createDisposableAppProfile('brainstrike-bootstrap-window-quit-');
  const electron: unknown = createRequire(import.meta.url)('electron');
  if (typeof electron !== 'string') {
    throw new Error('Missing Electron executable');
  }
  const application = await _electron.launch({
    args: [join(desktop, 'dist/main.js'), '--test-mode', `--user-data-dir=${root}`],
    env: {
      ...electronSessionEnvironment(),
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
      BRAINSTRIKE_E2E_USER_DATA_DIR: root,
      ELECTRON_IS_E2E_TEST: 'true',
      HOME: root,
      MASTRA_TELEMETRY_DISABLED: 'true',
      NODE_ENV: 'test',
      ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}),
    },
    executablePath: electron,
  });
  const main = application.process();
  let output = '';
  main.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  try {
    await application.firstWindow();
    await application.evaluate(({ app, dialog }) => {
      // Observe the real UI action without letting an unexpected modal block
      // the process and hide the causal failure behind a shutdown deadline.
      dialog.showErrorBox = () => {
        process.stdout.write(`${JSON.stringify({ event: 'startup-failure-dialog' })}\n`);
      };
      app.quit();
    });
    await application.close();
    expect(main.exitCode).toBe(0);
    expect(output).not.toContain('{"event":"startup-failure-dialog"}');
  } finally {
    await application.close();
  }
}, 30_000);
