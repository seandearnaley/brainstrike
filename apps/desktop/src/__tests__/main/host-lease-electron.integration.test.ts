// @vitest-environment node
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { makeThrowingDecoder, runWithTimeout } from '@brainstrike/effect-kit';
import {
  attachHost,
  createNodeHostSpawner,
  decodeHostRecord,
  type HostAttachment,
  type HostRecord,
  launchHost,
} from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const decodeReport = makeThrowingDecoder(
  Schema.Struct({
    event: Schema.String,
    message: Schema.optional(Schema.String),
    owned: Schema.optional(Schema.Boolean),
    record: Schema.optional(Schema.Unknown),
  }),
  { onExcessProperty: 'error' }
);
interface AppChild {
  readonly attached: Promise<HostRecord>;
  close(): Promise<void>;
  readonly exited: Promise<number | null>;
  ownsHost(): boolean;
  readonly process: ChildProcessWithoutNullStreams;
}
let directory: string;
let entrypoint: string;
let driver: string;
const activeApps = new Set<AppChild>();
const attachments = new Set<HostAttachment>();
const cliPids = new Map<number, string>();
function electronPath(): string {
  const value: unknown = createRequire(import.meta.url)('electron');
  if (typeof value !== 'string') {
    throw new TypeError('Electron package did not expose its executable path');
  }
  return value;
}

beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  directory = await mkdtemp(join(resolve('dist'), 'host-lease-proof-'));
  entrypoint = join(directory, 'host-lease-entry.js');
  driver = join(directory, 'driver.js');
  // Real production bundle format, external package graph and Electron runtime.
  await build({
    absWorkingDir: resolve('.'),
    bundle: true,
    entryPoints: {
      driver: 'src/__tests__/fixtures/host-lease-electron.ts',
      'host-lease-entry': 'src/host-lease-entry.ts',
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
afterAll(async () => {
  await Promise.all([...attachments].map((attachment) => attachment.close()));
  const cleanupFailures: unknown[] = [];
  await Promise.all(
    [...activeApps].map(async (app) => {
      try {
        await app.close();
      } catch (cause) {
        cleanupFailures.push(cause);
        // Only this harness's own Electron child is eligible for failed-test cleanup.
        app.process.kill('SIGKILL');
        await app.exited;
      }
    })
  );
  for (const [pid, start] of cliPids) {
    if (processStartTime(pid) === start) {
      process.kill(pid, 'SIGTERM');
      await waitGone(pid, start);
    }
  }
  await rm(directory, { force: true, recursive: true });
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Electron test child cleanup failed');
  }
});
async function waitGone(pid: number, start: string): Promise<void> {
  await runWithTimeout(
    async (signal) => {
      while (processStartTime(pid) === start) {
        signal.throwIfAborted();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    { onTimeout: () => new Error(`Host pid ${pid} stayed alive`), timeoutMs: 5000 }
  );
}
function startApp(root: string, startupTimeoutMs?: number): AppChild {
  const env = { ...process.env };
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE');
  env['NODE_PATH'] = resolve('node_modules');
  const args = [driver, root, entrypoint, String(startupTimeoutMs ?? 10_000)];
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    // Chromium refuses root in this isolated test container without this flag.
    args.push('--no-sandbox');
  }
  const child = spawn(electronPath(), args, { env, stdio: 'pipe' });
  const completion = Promise.withResolvers<HostRecord>();
  completion.promise.catch(() => undefined);
  let buffered = '';
  let stderr = '';
  let owned = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      completion.reject(new Error(`Electron exited ${code}: ${stderr}`));
      resolve(code);
    });
  });
  child.once('error', (cause) => completion.reject(cause));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        const report = decodeReport(JSON.parse(line));
        if (report.event === 'attached') {
          if (report.owned === undefined) {
            throw new Error('Electron fixture omitted host ownership');
          }
          owned = report.owned;
          completion.resolve(decodeHostRecord(report.record));
        } else if (report.event === 'failed') {
          stderr += `${report.message}\n`;
          completion.reject(new Error(report.message));
        }
      } catch (cause) {
        completion.reject(cause);
      }
      newline = buffered.indexOf('\n');
    }
  });
  const app: AppChild = {
    attached: runWithTimeout(() => completion.promise, {
      onTimeout: () => new Error(`Electron did not attach: ${stderr}`),
      timeoutMs: 10_000,
    }),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.write('close\n');
      }
      const code = await runWithTimeout(() => exited, {
        onTimeout: () => new Error('Electron did not close'),
        timeoutMs: 5000,
      });
      activeApps.delete(app);
      if (code !== 0 && child.signalCode === null) {
        throw new Error(`Electron close exited ${code}: ${stderr}`);
      }
    },
    exited,
    ownsHost: () => owned,
    process: child,
  };
  app.attached.catch(() => undefined);
  activeApps.add(app);
  return app;
}
async function cli(root: string): Promise<HostAttachment> {
  const attachment = await launchHost(root, {
    lifetime: 'persistent',
    spawn: createNodeHostSpawner({
      entrypoint: resolve('../../packages/host-lease/dist/process-entry.js'),
    }),
  });
  cliPids.set(attachment.record.pid, attachment.record.start);
  attachments.add(attachment);
  return attachment;
}

describe('real Electron host lease acquisition', () => {
  it('lets two simultaneous apps attach to one owner and closes only the app that spawned it', async () => {
    const root = join(directory, 'app-race');
    const first = startApp(root);
    const second = startApp(root);
    const [a, b] = await Promise.all([first.attached, second.attached]);
    expect(a).toEqual(b);
    const options: unknown = JSON.parse(await readFile(join(root, 'host.json'), 'utf8'));
    expect(decodeHostRecord(options)).toEqual(a);
    expect(Number(first.ownsHost()) + Number(second.ownsHost())).toBe(1);
    const owned = first.ownsHost() ? first : second;
    const attached = owned === first ? second : first;
    await attached.close();
    expect(processStartTime(a.pid)).toBe(a.start);
    await owned.close();
    await waitGone(a.pid, a.start);
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
  });
  it('refuses a live root owner with no reachable discovery and preserves its lock', async () => {
    const root = join(directory, 'unavailable-owner');
    await mkdir(root, { mode: 0o700 });
    const lock = await RootLock.acquire(root);
    try {
      const app = startApp(root, 300);
      await expect(app.attached).rejects.toThrow(`pid ${lock.owner.pid}`);
      await app.close();
      expect(RootLock.inspect(root)?.owner).toEqual(lock.owner);
      expect(processStartTime(lock.owner.pid)).toBe(lock.owner.start);
    } finally {
      lock.release();
    }
  });
  it('attaches CLI to the app owner and joins cooperative close before another owner starts', async () => {
    const root = join(directory, 'app-first');
    const app = startApp(root);
    const record = await app.attached;
    expect(processStartTime(record.pid)).toBe(record.start);
    const attachment = await cli(root);
    expect(attachment.record).toEqual(record);
    await app.close();
    await attachment.closed;
    await waitGone(record.pid, record.start);
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await expect(readFile(join(root, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const replacement = await cli(root);
    expect(replacement.record.token).not.toBe(record.token);
  });
  it('attaches desktop to an existing CLI owner and leaves that owner reachable after desktop close', async () => {
    const root = join(directory, 'cli-first');
    const attachment = await cli(root);
    const app = startApp(root);
    expect(await app.attached).toEqual(attachment.record);
    await app.close();
    expect(processStartTime(attachment.record.pid)).toBe(attachment.record.start);
    const additional = await attachHost(attachment.record);
    await additional.close();
  });
  it('releases an app-owned host after actual Electron parent death with a CLI still attached', async () => {
    const root = join(directory, 'parent-death');
    const app = startApp(root);
    const record = await app.attached;
    const attachment = await cli(root);
    app.process.kill('SIGKILL');
    await app.exited;
    activeApps.delete(app);
    await attachment.closed;
    await waitGone(record.pid, record.start);
    // Electron may terminate its utility before the PID monitor can flush release.
    // Gone identity is authoritative: a replacement must take over that stale lease.
    const replacement = await cli(root);
    expect(replacement.record.pid).not.toBe(record.pid);
    expect(replacement.record.token).not.toBe(record.token);
  });
}, 20_000);
