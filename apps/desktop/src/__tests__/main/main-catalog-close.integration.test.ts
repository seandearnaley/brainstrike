// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { attachAgentHost } from '@brainstrike/agent-host';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { createNodeHostSpawner, launchHost } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { build } from 'esbuild';
import { beforeAll, expect, test } from 'vitest';
import { electronExecutablePath } from '../helpers/electron-executable';

let directory: string;
beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  directory = await mkdtemp(join(resolve('dist'), 'main-catalog-proof-'));
  await build({
    absWorkingDir: resolve('.'),
    bundle: true,
    entryPoints: {
      'agent-host-entry': 'src/agent-host-entry.ts',
      driver: 'src/__tests__/fixtures/main-catalog-close-electron.ts',
      'main-catalog-platform': 'src/__tests__/fixtures/main-catalog-platform.ts',
    },
    format: 'cjs',
    nodePaths: [resolve('node_modules')],
    outdir: directory,
    packages: 'external',
    platform: 'node',
    target: 'node24',
    tsconfigRaw: '{}',
  });
}, 30_000);

test.each([
  ['owned', 'workspaceRoots', 'ack-first'],
  ['owned', 'workspaceRoots', 'held'],
  ['attached', 'workspaceRoots', 'held'],
  ['owned', 'worktreeLedger', 'held'],
  ['attached', 'worktreeLedger', 'held'],
  ['owned', 'workspaceRoots', 'rejected'],
  ['owned', 'worktreeLedger', 'stuck'],
] as const)(
  'actual Main lease %s %s %s settles before retirement or the existing deadline',
  async (kernel, method, mode) => {
    const proof = await mkdtemp(join(directory, `${kernel}-${method}-${mode}-`));
    const root = join(proof, 'profile');
    const owner =
      kernel === 'attached'
        ? await launchHost(root, {
            attach: attachAgentHost,
            lifetime: 'persistent',
            spawn: createNodeHostSpawner({
              entryArgs: [join(directory, 'main-catalog-platform.js')],
              entrypoint: resolve('../../packages/agent-host/dist/process-entry.js'),
              output: 'ignore',
            }),
          })
        : undefined;
    const env = { ...process.env };
    Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE');
    const args = [
      join(directory, 'driver.js'),
      mode,
      proof,
      kernel,
      method,
      directory,
      `--user-data-dir=${join(proof, 'electron-user-data')}`,
    ];
    if (process.platform === 'linux' && process.getuid?.() === 0) {
      args.push('--no-sandbox');
    }
    const child = spawn(electronExecutablePath(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    try {
      const code = await runWithTimeout(() => exited, {
        onTimeout: () => new Error(`Electron catalog proof timed out: ${output}`),
        timeoutMs: 20_000,
      });
      expect(code, output).toBe(0);
      const report = await readFile(join(proof, 'report.json'), 'utf8');
      expect(report).toContain('committed-response-held');
      if (mode === 'held') {
        expect(report).toContain('still-pending-before-release');
      }
      if (mode === 'stuck') {
        expect(report).toContain('main-catalog');
        expect(report).toContain('"forcedExit": 1');
      }
      if (owner) {
        expect(processStartTime(owner.record.pid)).toBe(owner.record.start);
        expect(RootLock.isFlockHeld(root)).toBe(true);
        const extra = await attachAgentHost(owner.record);
        try {
          expect(await extra.request('thread/list', {})).toEqual({ threads: [] });
        } finally {
          await extra.close();
        }
      }
    } finally {
      await writeFile(join(proof, 'electron.log'), output);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'gate-released'), 'parent cleanup');
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      await exited;
      if (owner) {
        const control = await attachAgentHost(owner.record);
        try {
          await control.request('host/stop', {});
        } finally {
          await control.close();
          await owner.close();
        }
        await runWithTimeout(
          async (signal) => {
            while (processStartTime(owner.record.pid) === owner.record.start) {
              signal.throwIfAborted();
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
          },
          { onTimeout: () => new Error('Fixture-owned Node kernel did not exit'), timeoutMs: 5000 }
        );
      }
    }
    expect(RootLock.isFlockHeld(root)).toBe(false);
    const reopened = await StateStore.open(root);
    try {
      const { roots } = await reopened.workspaceRoots({ operation: 'list' });
      expect(roots).toHaveLength(2);
      expect(roots.map((entry) => entry.id).sort()).toEqual([
        '05bca9c7-7cb6-40ef-8204-4d04fbd46b09',
        'b5f5883e-c414-485a-9c1b-1b43a579ca10',
      ]);
      if (method === 'workspaceRoots' && mode !== 'rejected') {
        expect(roots.every((entry) => entry.status === 'live')).toBe(true);
      }
    } finally {
      await reopened.close();
    }
  },
  30_000
);
