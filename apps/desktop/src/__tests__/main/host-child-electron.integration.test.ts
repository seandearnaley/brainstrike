// @vitest-environment node
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openAgentHost } from '@brainstrike/agent-host';
import { authenticateHostClient } from '@brainstrike/agent-host/client';
import { AGENT_HOST_PROTOCOL_VERSION, HOST_VERSION } from '@brainstrike/agent-host/protocol';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { joinProcessExit, processStartTime } from '@brainstrike/test-utils/process-identity';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { Schema } from 'effect';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { mainPlatformConnection } from '../../agent-host-platform/connection';
import { encodeHostChildArgs } from '../../host-child-messages';
import { HOST_CLOSE_GRACE_MS } from '../../host-lease-manager';
import { openHostStdio } from '../../host-stdio';
import { electronExecutablePath } from '../helpers/electron-executable';
import { isRootHeld } from '../helpers/root-held';

type KillMoment = 'first-chunk' | 'ready' | 'spawn';
interface KillTrial {
  readonly after: KillMoment;
  readonly killAfterMs: number;
  shownChunks: number;
  threadId?: string;
}
/** Kills per run, cycling through the moments each is timed from. */
const KILL_TRIALS = 9;
const KILL_MOMENTS: readonly KillMoment[] = ['spawn', 'ready', 'first-chunk'];
/** The random delay's bound after each moment: the scripted answer streams for about 1 s. */
const KILL_WITHIN_MS: Readonly<Record<KillMoment, number>> = {
  'first-chunk': 1000,
  ready: 500,
  spawn: 2500,
};

/** Electron's launch plus the one close grace; the test waits on real events only. */
const TEST_BUDGET_MS = getAdjustedTimeout('uiComponent') + HOST_CLOSE_GRACE_MS;

const decodeReport = makeThrowingDecoder(
  Schema.Struct({
    event: Schema.String,
    host: Schema.optional(Schema.Struct({ pid: Schema.Int, start: Schema.String })),
    message: Schema.optional(Schema.String),
    threadId: Schema.optional(Schema.String),
  }),
  { onExcessProperty: 'error' }
);
interface Attached {
  readonly host: { readonly pid: number; readonly start: string };
  readonly threadId: string;
}
interface AppChild {
  readonly attached: Promise<Attached>;
  close(): Promise<number | null>;
  readonly exited: Promise<number | null>;
  readonly process: ChildProcessWithoutNullStreams;
}
let directory: string;
let driver: string;
let agentEntrypoint: string;
let agentPlatform: string;
let streamingPlatform: string;
let stuckClosePlatform: string;
const activeApps = new Set<AppChild>();

beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  directory = await mkdtemp(join(resolve('dist'), 'host-child-proof-'));
  driver = join(directory, 'driver.cjs');
  agentEntrypoint = join(directory, 'agent-host-entry.cjs');
  agentPlatform = join(directory, 'agent-host-utility-platform.cjs');
  streamingPlatform = join(directory, 'agent-host-streaming-platform.cjs');
  stuckClosePlatform = join(directory, 'agent-host-stuck-close-platform.cjs');
  // Real production bundle format, external package graph and Electron runtime.
  await build({
    absWorkingDir: resolve('.'),
    bundle: true,
    entryPoints: {
      'agent-host-entry': 'src/agent-host-entry.ts',
      'agent-host-streaming-platform': 'src/__tests__/fixtures/agent-host-streaming-platform.ts',
      'agent-host-stuck-close-platform':
        'src/__tests__/fixtures/agent-host-stuck-close-platform.ts',
      'agent-host-utility-platform': 'src/__tests__/fixtures/agent-host-utility-platform.ts',
      driver: 'src/__tests__/fixtures/host-child-electron.ts',
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
  for (const app of activeApps) {
    if (app.process.exitCode === null && app.process.signalCode === null) {
      app.process.kill('SIGKILL');
    }
    await app.exited;
  }
  await rm(directory, { force: true, recursive: true });
}, TEST_BUDGET_MS);

function startApp(root: string): AppChild {
  const env = { ...process.env, NODE_PATH: resolve('node_modules') };
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE');
  const args = [
    driver,
    root,
    agentEntrypoint,
    agentPlatform,
    `--user-data-dir=${join(directory, `electron-profile-${randomUUID()}`)}`,
  ];
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    // Chromium refuses root in this isolated test container without this flag.
    args.push('--no-sandbox');
  }
  const child = spawn(electronExecutablePath(), args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }) as ChildProcessWithoutNullStreams;
  const attached = Promise.withResolvers<Attached>();
  attached.promise.catch(() => undefined);
  let stdout = '';
  let stderr = '';
  let buffered = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => {
      attached.reject(new Error(`Electron exited ${code}: ${stderr}`));
      done(code);
    });
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (line === '') {
        continue;
      }
      const report = decodeReport(JSON.parse(line));
      if (report.event === 'attached' && report.host && report.threadId) {
        attached.resolve({ host: report.host, threadId: report.threadId });
      } else if (report.event === 'failed') {
        attached.reject(new Error(report.message));
      }
    }
  });
  const app: AppChild = {
    attached: attached.promise,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        // An app that already began quitting has closed its channel; its exit is the answer.
        await new Promise<void>((done) => {
          child.send('close', () => done());
        });
      }
      const code = await exited;
      activeApps.delete(app);
      return code;
    },
    exited,
    process: child,
  };
  activeApps.add(app);
  onTestFailed(() => {
    console.error(
      `Electron fixture stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`
    );
  });
  return app;
}
/** Every row the host committed, read back by a host opened on the same root afterwards. */
async function committedLog(
  root: string,
  threadId: string
): Promise<readonly { readonly seq: number; readonly type: string }[]> {
  const reader = await openAgentHost(root, {
    close: async () => undefined,
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => {
      throw new Error('No model in this reader');
    },
    tools: {},
  });
  try {
    return (await reader.core.read(threadId, 0)).map((row) => ({
      seq: row.seq,
      type: row.event.type,
    }));
  } finally {
    await reader.close();
  }
}

/** What the app's host committed, read back by a host opened on the same root afterwards. */
async function committedRows(root: string, threadId: string): Promise<readonly string[]> {
  const reader = await openAgentHost(root, {
    close: async () => undefined,
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => {
      throw new Error('No model in this reader');
    },
    tools: {},
  });
  try {
    return (await reader.core.read(threadId, 0)).map((row) => row.event.type);
  } finally {
    await reader.close();
  }
}

describe(
  'the desktop host as a headless child process of Main',
  () => {
    it('runs under plain Node with no Electron: serves a client over its stdio and ends at stdin EOF', async () => {
      const root = join(directory, 'headless');
      const env = { ...process.env, NODE_PATH: resolve('node_modules') };
      Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE');
      const host = spawn(
        process.execPath,
        [
          agentEntrypoint,
          ...encodeHostChildArgs({ modulePath: agentPlatform, parentPid: process.pid, root }),
        ],
        { env, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let stderr = '';
      host.stderr.setEncoding('utf8');
      host.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      onTestFailed(() => console.error(`Headless host stderr=${JSON.stringify(stderr)}`));
      const exited = new Promise<number | null>((done) => host.once('close', done));
      const ready = Promise.withResolvers<void>();
      const stdio = openHostStdio(host.stdout, host.stdin, {
        invalid: ready.reject,
        message: (message) => {
          expect(message).toEqual({ event: 'ready' });
          ready.resolve();
        },
      });
      await ready.promise;
      const port = stdio.open('main');
      const closed = new Promise<void>((done) => port.on('close', () => done()));
      const client = await authenticateHostClient(
        mainPlatformConnection(port),
        { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
        async () => port.close(),
        closed
      );
      const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
      expect(client.host.pid).toBe(host.pid);
      // Ending its stdin is the whole ask: the host closes and exits on its own.
      stdio.end();
      expect(await exited).toBe(0);
      await closed;
      expect(await committedRows(root, threadId)).toEqual(['command.accepted', 'thread.started']);
    });

    it('ends at stdin EOF without joining a close that never settles, and releases the Root', async () => {
      // ADR-0031: every write is committed when made, so the host's exit needs nothing from its
      // children; the OS releases the Root and ends what the host started.
      const root = join(directory, 'stuck-close');
      const env = { ...process.env, NODE_PATH: resolve('node_modules') };
      Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE');
      const host = spawn(
        process.execPath,
        [
          agentEntrypoint,
          ...encodeHostChildArgs({ modulePath: stuckClosePlatform, parentPid: process.pid, root }),
        ],
        { env, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      host.stderr.resume();
      const exited = new Promise<number | null>((done) => host.once('exit', done));
      const ready = Promise.withResolvers<void>();
      const stdio = openHostStdio(host.stdout, host.stdin, {
        invalid: ready.reject,
        message: () => ready.resolve(),
      });
      await ready.promise;
      const port = stdio.open('main');
      const closed = new Promise<void>((done) => port.on('close', () => done()));
      const client = await authenticateHostClient(
        mainPlatformConnection(port),
        { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
        async () => port.close(),
        closed
      );
      const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
      stdio.end();
      expect(await exited).toBe(0);
      expect(isRootHeld(root)).toBe(false);
      expect(await committedRows(root, threadId)).toEqual(['command.accepted', 'thread.started']);
    });

    it(
      'loses nothing it committed when it is killed at random moments of a streaming run',
      async () => {
        // ADR-0031 §1: every write commits immediately, so a kill at any moment loses nothing
        // committed. One root, crash-recovered every trial. Each kill lands a random time after
        // one of three moments: the spawn (startup), ready (thread and run start) or the first
        // streamed chunk the client was shown (mid-stream).
        const root = join(directory, 'random-kills');
        // A kill before the host creates its root still leaves a root to check.
        await mkdir(root, { recursive: true });
        const env = { ...process.env, NODE_PATH: resolve('node_modules') };
        Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE');
        const trials: KillTrial[] = [];
        onTestFailed(() => console.error(`Random kill trials: ${JSON.stringify(trials)}`));
        for (let index = 0; index < KILL_TRIALS; index += 1) {
          const after = KILL_MOMENTS[index % KILL_MOMENTS.length] ?? 'spawn';
          const trial: KillTrial = {
            after,
            killAfterMs: Math.floor(Math.random() * KILL_WITHIN_MS[after]),
            shownChunks: 0,
          };
          trials.push(trial);
          const host = spawn(
            process.execPath,
            [
              agentEntrypoint,
              ...encodeHostChildArgs({
                modulePath: streamingPlatform,
                parentPid: process.pid,
                root,
              }),
            ],
            { env, stdio: ['pipe', 'pipe', 'pipe'] }
          );
          const pid = host.pid;
          const start = pid === undefined ? null : processStartTime(pid);
          if (pid === undefined || start === null) {
            throw new Error('The host did not start');
          }
          const exited = new Promise<void>((done) => host.once('exit', () => done()));
          host.stderr.resume();
          // The random moment; the kill is the only way this host ends.
          let kill: ReturnType<typeof setTimeout> | undefined;
          const arm = (moment: KillMoment): void => {
            if (moment === after && kill === undefined) {
              kill = setTimeout(() => host.kill('SIGKILL'), trial.killAfterMs);
            }
          };
          arm('spawn');
          const shown = new Map<number, string>();
          const drive = (async () => {
            const ready = Promise.withResolvers<void>();
            const stdio = openHostStdio(host.stdout, host.stdin, {
              invalid: ready.reject,
              message: () => ready.resolve(),
            });
            void exited.then(() => ready.reject(new Error('The host was killed before ready')));
            await ready.promise;
            arm('ready');
            const port = stdio.open('main');
            const closed = new Promise<void>((done) => port.on('close', () => done()));
            const client = await authenticateHostClient(
              mainPlatformConnection(port),
              { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
              async () => port.close(),
              closed
            );
            client.onEvent((row) => {
              shown.set(row.seq, row.event.type);
              if (row.event.type === 'stream.chunk') {
                arm('first-chunk');
              }
            });
            const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
            trial.threadId = threadId;
            await client.request('log/subscribe', { fromSeq: 0, threadId });
            await client.request('run/start', {
              commandId: randomUUID(),
              modelId: 'scripted',
              prompt: 'Stream the long answer.',
              threadId,
            });
            // Held until the kill, which ends the host whether or not the run has finished.
            await closed;
          })();
          // Any outcome of the client is the kill's; only what was committed is checked.
          await drive.catch(() => undefined);
          await exited;
          clearTimeout(kill);
          await joinProcessExit(pid, start);
          expect(isRootHeld(root)).toBe(false);
          trial.shownChunks = [...shown.values()].filter((type) => type === 'stream.chunk').length;
          if (after === 'first-chunk') {
            expect(trial.shownChunks).toBeGreaterThan(0);
          }
          if (trial.threadId === undefined) {
            continue;
          }
          const committed = await committedLog(root, trial.threadId);
          // Gapless: the reopened log is every seq from 1 on, and holds each row the client was shown.
          expect(committed.map((row) => row.seq)).toEqual(committed.map((_, seq) => seq + 1));
          const bySeq = new Map(committed.map((row) => [row.seq, row.type]));
          for (const [seq, type] of shown) {
            expect({ seq, type: bySeq.get(seq) }).toEqual({ seq, type });
          }
        }
      },
      KILL_TRIALS * TEST_BUDGET_MS
    );

    it("serves Main, and the app's close ends it and releases the Root", async () => {
      const root = join(directory, 'close');
      const app = startApp(root);
      const { host, threadId } = await app.attached;
      expect(await app.close()).toBe(0);
      // Main's close joined the child's exit before the app quit, so the Root is free to open.
      expect(processStartTime(host.pid)).not.toBe(host.start);
      expect(await committedRows(root, threadId)).toEqual(['command.accepted', 'thread.started']);
    });

    it('loses nothing it committed when the app is killed, and its host dies with the app', async () => {
      const root = join(directory, 'killed');
      const app = startApp(root);
      const { host, threadId } = await app.attached;
      app.process.kill('SIGKILL');
      await app.exited;
      activeApps.delete(app);
      // The host's stdin ends with the app, so it closes; its exit releases the Root's lock.
      await joinProcessExit(host.pid, host.start);
      expect(isRootHeld(root)).toBe(false);
      expect(await committedRows(root, threadId)).toEqual(['command.accepted', 'thread.started']);
    });

    // A stopped host never reads its stdin's end, and POSIX keeps it stopped past the app's
    // death. Linux's parent-death signal is a SIGKILL, which ends a stopped process too.
    it.runIf(process.platform === 'linux')('a stopped host dies with the app', async () => {
      const root = join(directory, 'stopped');
      const app = startApp(root);
      const { host } = await app.attached;
      onTestFailed(() => {
        if (processStartTime(host.pid) === host.start) {
          process.kill(host.pid, 'SIGKILL');
        }
      });
      process.kill(host.pid, 'SIGSTOP');
      app.process.kill('SIGKILL');
      await app.exited;
      activeApps.delete(app);
      await joinProcessExit(host.pid, host.start);
      expect(isRootHeld(root)).toBe(false);
    });

    it('refuses a second app on the same root while the first has it open', async () => {
      const root = join(directory, 'second');
      const first = startApp(root);
      await first.attached;
      const second = startApp(root);
      await expect(second.attached).rejects.toThrow(/lock|in use|already/i);
      await second.close();
      expect(await first.close()).toBe(0);
    });
  },
  TEST_BUDGET_MS
);
