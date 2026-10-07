import { execFile } from 'node:child_process';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
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

interface CommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

function environment(): NodeJS.ProcessEnv {
  const selected = Object.fromEntries(
    [
      'PATH',
      'SystemRoot',
      'TEMP',
      'TMP',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'pnpm_config_enable_global_virtual_store',
      'PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE',
      'pnpm_config_store_dir',
      'PNPM_CONFIG_STORE_DIR',
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

function command(executable: string, args: string[], cwd: string): Promise<CommandResult> {
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

function installedCommand(
  name: string,
  args: string[],
  cwd = workspaceRoot
): Promise<CommandResult> {
  const pnpm = process.env['npm_execpath'];
  if (!(pnpm && /\.(?:c|m)?js$/.test(pnpm))) {
    throw new Error('Run CLI executable integration with pnpm run test:integration');
  }
  return command(
    process.execPath,
    [pnpm, '--filter', '@brainstrike/desktop', 'exec', name, ...args],
    cwd
  );
}

function installedExecutable(name: string, args: string[]): Promise<CommandResult> {
  const executable = join(workspaceRoot, 'apps/desktop/node_modules/.bin', name);
  // pnpm's recursive exec wrapper turns every nonzero child exit into 1 and
  // adds its own stdout diagnostics. Invoke the installed shim to observe the
  // CLI's actual stdout and exit 2 contract, including the Windows ps1 shim.
  return process.platform === 'win32'
    ? command(
        process.env['M3_WINDOWS_POWERSHELL'] ?? 'pwsh.exe',
        ['-NoProfile', '-NonInteractive', '-File', `${executable}.ps1`, ...args],
        workspaceRoot
      )
    : command(executable, args, workspaceRoot);
}

afterEach(async () => {
  vi.unstubAllEnvs();
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

test.each(['tracked executable', 'brainstrike', 'brainstrike-host'])(
  '%s preserves the committed noninteractive approval exit',
  async (name) => {
    const dataRoot = await root();
    const options = { lifetime: 'persistent' as const, root: dataRoot };
    const host = await startAgentHost(options, (context) =>
      loadHostPlatform(platform, options, context)
    );
    hosts.push(host);
    const args = [
      '--data-root',
      dataRoot,
      'run',
      'Use the existing scripted fixture.',
      '--model',
      'scripted',
      '--json',
      '--non-interactive',
    ];
    const result =
      name === 'tracked executable'
        ? await command(process.execPath, [shim, ...args], await root())
        : await installedExecutable(name, args);
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
  }
);

test.each(['brainstrike', 'brainstrike-host'])(
  'normal workspace installation exposes the %s executable',
  async (name) => {
    const direct = await command(process.execPath, [shim, '--help'], workspaceRoot);
    const installed = await installedCommand(name, ['--help']);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(direct.stdout);
    expect(installed.stderr).toBe(direct.stderr);
    const invalid = await installedExecutable(name, ['unknown-command']);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr.length).toBeGreaterThan(0);
  }
);

test.each(['brainstrike', 'brainstrike-host'])(
  'installed %s stops the authenticated owner and releases its Root',
  async (name) => {
    const dataRoot = await root();
    const options = { lifetime: 'persistent' as const, root: dataRoot };
    const host = await startAgentHost(options, (context) =>
      loadHostPlatform(platform, options, context)
    );
    hosts.push(host);
    const result = await installedExecutable(name, ['--data-root', dataRoot, 'host', 'stop']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ outcome: 'stopped', rootReleased: true });
    expect(result.stderr).toBe('');
    expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
    await expect(access(join(dataRoot, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(dataRoot, 'fixture-platform-closed'), 'utf8')).toBe(
      `${process.pid}\n`
    );
    await host.closed;
  }
);

test.each(['pnpm_config_enable_global_virtual_store', 'PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE'])(
  'normal frozen workspace installation preserves %s and exposes both aliases before compilation',
  async (setting) => {
    // Keep an explicit installed closure through both supported env spellings.
    // The dependency guard must remain strict in every child command.
    if (process.platform !== 'win32') {
      vi.stubEnv(
        setting === 'pnpm_config_enable_global_virtual_store'
          ? 'PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE'
          : 'pnpm_config_enable_global_virtual_store',
        undefined
      );
    }
    vi.stubEnv(setting, 'false');
    const pnpm = process.env['npm_execpath'];
    if (!(pnpm && /\.(?:c|m)?js$/.test(pnpm))) {
      throw new Error('Run CLI executable integration with pnpm run test:integration');
    }
    const cwd = await root();
    const packagedHost = join(cwd, 'host');
    const manifest: {
      readonly name: string;
      readonly version: string;
      readonly dependencies: Record<string, string>;
    } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    // PNPM supplies dependency links to the already qualified pinned closure.
    // The isolated manifest stages Studio's required bin delta without editing it.
    const dependencies = Object.fromEntries(
      await Promise.all(
        Object.keys(manifest.dependencies).map(async (name) => [
          name,
          `link:${await realpath(join(packageRoot, 'node_modules', name))}`,
        ])
      )
    );
    await mkdir(join(packagedHost, 'bin'), { recursive: true });
    await copyFile(shim, join(packagedHost, 'bin/brainstrike.mjs'));
    await writeFile(
      join(packagedHost, 'package.json'),
      JSON.stringify({
        bin: { brainstrike: './bin/brainstrike.mjs', 'brainstrike-host': './bin/brainstrike.mjs' },
        dependencies,
        name: manifest.name,
        private: true,
        type: 'module',
        version: manifest.version,
      })
    );
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { [manifest.name]: 'workspace:*' }, private: true })
    );
    await writeFile(join(cwd, 'pnpm-workspace.yaml'), 'packages:\n  - host\n');
    const selectedClosure = await command(
      process.execPath,
      [pnpm, 'config', 'get', 'enable-global-virtual-store'],
      cwd
    );
    expect(selectedClosure.code).toBe(0);
    expect(selectedClosure.stdout.trim()).toBe('false');
    expect(
      await command(process.execPath, [pnpm, 'install', '--lockfile-only', '--offline'], cwd)
    ).toMatchObject({ code: 0 });
    expect(
      await command(process.execPath, [pnpm, 'install', '--frozen-lockfile', '--offline'], cwd)
    ).toMatchObject({ code: 0 });
    for (const name of ['brainstrike', 'brainstrike-host']) {
      const cold = await command(process.execPath, [pnpm, 'exec', name, '--help'], cwd);
      expect(cold.code).toBe(1);
      expect(cold.stdout).toBe('');
      expect(cold.stderr).toContain('Brainstrike CLI is not built.');
    }
    await cp(join(packageRoot, 'dist'), join(packagedHost, 'dist'), { recursive: true });
    const direct = await command(process.execPath, [shim, '--help'], cwd);
    expect(direct.code).toBe(0);
    for (const name of ['brainstrike', 'brainstrike-host']) {
      const installed = await command(process.execPath, [pnpm, 'exec', name, '--help'], cwd);
      expect(installed).toEqual(direct);
      const directError = await command(process.execPath, [shim, 'unknown-command'], cwd);
      const installedError = await command(
        process.execPath,
        [pnpm, 'exec', name, 'unknown-command'],
        cwd
      );
      expect(installedError).toEqual(directError);
      expect(installedError.code).toBe(1);
    }
  }
);
