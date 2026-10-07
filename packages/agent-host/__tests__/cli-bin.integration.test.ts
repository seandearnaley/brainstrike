import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { loadHostPlatform } from '../src/process-entry.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { removeFixtureRoot } from './fixtures/cooperative-host-fixture.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const shim = join(packageRoot, 'bin/brainstrike.mjs');
const compiled = join(packageRoot, 'dist/cli.js');
const platform = fileURLToPath(new URL('./fixtures/process-platform.mjs', import.meta.url));
const roots: string[] = [];
const hosts: AgentHost[] = [];

function environment(): NodeJS.ProcessEnv {
  const selected = Object.fromEntries(
    [
      'PATH',
      'SystemRoot',
      'TEMP',
      'TMP',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'pnpm_config_store_dir',
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  );
  return { ...selected, LC_ALL: 'C', pnpm_config_verify_deps_before_run: 'error', TZ: 'UTC' };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'bs-m3-cli-bin-'));
  roots.push(value);
  return value;
}

function command(
  executable: string,
  args: string[],
  cwd: string
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd, encoding: 'utf8', env: environment(), timeout: 10_000, windowsHide: true },
      (cause, stdout, stderr) => {
        if (!cause) {
          resolve({ code: 0, stderr, stdout });
        } else if (typeof cause.code === 'number') {
          resolve({ code: cause.code, stderr, stdout });
        } else {
          reject(cause);
        }
      }
    );
  });
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.close();
  }
  for (const value of roots.splice(0)) {
    await removeFixtureRoot(value);
  }
});

test('tracked executable delegates help and argument errors from another working directory', async () => {
  const cwd = await root();
  const direct = await command(process.execPath, [compiled, '--help'], cwd);
  expect(await command(process.execPath, [shim, '--help'], cwd)).toEqual(direct);
  expect(direct.code).toBe(0);
  expect(direct.stdout.length).toBeGreaterThan(0);
  const directError = await command(process.execPath, [compiled, 'unknown-command'], cwd);
  expect(await command(process.execPath, [shim, 'unknown-command'], cwd)).toEqual(directError);
  expect(directError.code).toBe(1);
});

test('tracked executable exists before compilation and reports the missing build', async () => {
  const cwd = await root();
  await mkdir(join(cwd, 'bin'));
  const coldShim = join(cwd, 'bin/brainstrike.mjs');
  await copyFile(shim, coldShim);
  const result = await command(process.execPath, [coldShim, '--help'], cwd);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.length).toBeGreaterThan(0);
  expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
});

test('tracked executable preserves the committed noninteractive approval exit', async () => {
  const dataRoot = await root();
  const options = { lifetime: 'persistent' as const, root: dataRoot };
  const host = await startAgentHost(options, (context) =>
    loadHostPlatform(platform, options, context)
  );
  hosts.push(host);
  const result = await command(
    process.execPath,
    [
      shim,
      '--data-root',
      dataRoot,
      'run',
      'Use the existing scripted fixture.',
      '--model',
      'scripted',
      '--json',
      '--non-interactive',
    ],
    await root()
  );
  expect(result.code).toBe(2);
  const rows: unknown[] = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows).toContainEqual(
    expect.objectContaining({ event: expect.objectContaining({ type: 'interaction.requested' }) })
  );
  expect(rows).not.toContainEqual(
    expect.objectContaining({ event: expect.objectContaining({ type: 'effect.started' }) })
  );
});

test.each(['brainstrike', 'brainstrike-host'])(
  'normal workspace installation exposes the %s executable',
  async (name) => {
    const pnpm = process.env['npm_execpath'];
    if (!(pnpm && /\.(?:c|m)?js$/.test(pnpm))) {
      throw new Error('Run CLI executable integration with pnpm run test:integration');
    }
    const direct = await command(process.execPath, [shim, '--help'], workspaceRoot);
    const installed = await command(
      process.execPath,
      [pnpm, '--filter', '@brainstrike/assistant-ui', 'exec', name, '--help'],
      workspaceRoot
    );
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(direct.stdout);
    expect(installed.stderr).toBe(direct.stderr);
  }
);
