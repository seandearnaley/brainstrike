// @vitest-environment node
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronExecutablePath } from '../helpers/electron-executable';

// BST-2244: a @parcel/watcher subscribe or unsubscribe still on the libuv
// thread pool when Electron frees Main's Node environment completes into a
// dead JS context: `FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw`
// and SIGABRT on macOS, a fail-fast on Windows. Main's git inventory watchers
// left their unsubscribe in flight at quit. This launches real Electron with
// one pool thread held behind that unsubscribe, so an unjoined one crashes
// Main every run rather than on a lost race.
const execFileAsync = promisify(execFile);
const QUIT_TIMEOUT_MS = 60_000;
let directory: string;
let driver: string;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  directory = await mkdtemp(join(resolve('dist'), 'git-inventory-quit-proof-'));
  driver = join(directory, 'driver.js');
  // Real production bundle format, external package graph and Electron runtime.
  await build({
    absWorkingDir: resolve('.'),
    bundle: true,
    entryPoints: { driver: 'src/__tests__/fixtures/git-inventory-quit-electron.ts' },
    format: 'cjs',
    nodePaths: [resolve('node_modules')],
    outdir: directory,
    packages: 'external',
    platform: 'node',
    target: 'node24',
    tsconfigRaw: '{}',
  });
}, 30_000);

afterAll(async () => {
  await Promise.all(
    [directory, ...temporaryDirectories].map((path) => rm(path, { force: true, recursive: true }))
  );
});

async function makeRepository(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(os.tmpdir(), 'bst-2244-git-inventory-quit-')));
  temporaryDirectories.push(repo);
  await execFileAsync('git', ['init', '-q'], { cwd: repo });
  await writeFile(join(repo, 'a.txt'), 'a', 'utf8');
  await execFileAsync('git', ['add', 'a.txt'], { cwd: repo });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=test@brainstrike.dev',
      '-c',
      'user.name=Brainstrike Test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'seed',
    ],
    { cwd: repo }
  );
  return repo;
}

interface QuitOutcome {
  readonly code: number | null;
  readonly events: readonly { readonly detail: unknown; readonly event: string }[];
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

async function runToQuit(repo: string): Promise<QuitOutcome> {
  const userData = await mkdtemp(join(directory, 'electron-profile-'));
  const env: NodeJS.ProcessEnv = { ...process.env, UV_THREADPOOL_SIZE: '1' };
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE');
  env['NODE_PATH'] = resolve('node_modules');
  const args = [driver, repo, `--user-data-dir=${userData}`];
  if (process.platform === 'darwin') {
    // A crashed run must not leave the next launch behind AppKit's restore prompt.
    args.push('-ApplePersistenceIgnoreState', 'YES');
  }
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    // Chromium refuses root in this isolated test container without this flag.
    args.push('--no-sandbox');
  }
  const child = spawn(electronExecutablePath(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        rejectExit(new Error(`Electron did not quit within ${QUIT_TIMEOUT_MS}ms: ${stderr}`));
      }, QUIT_TIMEOUT_MS);
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    }
  );
  // Main's structured logger shares stdout; the fixture's reports carry `event`.
  const events = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (line): line is { detail: unknown; event: string } => typeof line['event'] === 'string'
    );
  return { ...exit, events, stderr };
}

describe('git inventory shutdown (real Electron Main, real @parcel/watcher)', () => {
  it('quits cleanly when the libuv pool is busy behind the git-inventory step', async () => {
    const outcome = await runToQuit(await makeRepository());

    expect(outcome.events).toEqual([
      { detail: { errors: [], repositories: 1 }, event: 'synced' },
      { detail: null, event: 'watching' },
      { detail: null, event: 'stopped' },
    ]);
    expect(outcome.stderr).not.toContain('FATAL ERROR');
    expect({ code: outcome.code, signal: outcome.signal }).toEqual({ code: 0, signal: null });
  }, 90_000);
});
