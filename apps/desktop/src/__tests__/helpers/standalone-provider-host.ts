/**
 * The installed standalone `brainstrike` host over a disposable data root and
 * workspace, with every provider base-URL knob pointed at one loopback server
 * (the model-provider shim, or the cassette recorder). Real bin, real
 * HostCore, real provider SDKs; the committed log is read back through the
 * CLI exactly as any client reads it.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '@brainstrike/agent-host/protocol';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const bin = join(
  dirname(require.resolve('@brainstrike/host-capabilities')),
  '../bin/brainstrike.mjs'
);
export interface CliResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}
export interface StandaloneProviderHost {
  /** Child thread ids of `threadId`, in the host's order. */
  readonly children: (threadId: string) => Promise<readonly string[]>;
  readonly cli: (args: readonly string[]) => Promise<CliResult>;
  readonly close: () => Promise<void>;
  readonly rows: (threadId: string) => Promise<readonly HostLogRow[]>;
  /** `run --json --non-interactive`: blocks until the run ends (exit 0) or pauses (exit 2). */
  readonly run: (
    prompt: string,
    model: string
  ) => Promise<{
    readonly result: CliResult;
    readonly runId: string;
    readonly threadId: string;
  }>;
  /** `thread start` then `run start`: the run proceeds in the host while the caller watches. */
  readonly startRun: (
    prompt: string,
    model: string
  ) => Promise<{
    readonly runId: string;
    readonly threadId: string;
  }>;
  readonly workspace: string;
}
const RunIdentity = z.object({ runId: z.string(), threadId: z.string() });
/** A disposable workspace directory, canonical, named `name` (its basename is all a prompt sees). */
export async function createStandaloneWorkspace(
  name: string,
  files: Readonly<Record<string, string>> = {}
): Promise<{
  readonly remove: () => Promise<void>;
  readonly workspace: string;
}> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'bs-cassette-ws-')));
  const workspace = join(parent, name);
  await mkdir(workspace);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, file)), { recursive: true });
    await writeFile(join(workspace, file), content);
  }
  return { remove: () => rm(parent, { force: true, recursive: true }), workspace };
}
/**
 * `environment` is the host's whole provider environment: base-URL knobs and
 * credentials. Nothing else from this process's environment reaches the host.
 */
export async function startStandaloneProviderHost(options: {
  readonly environment: Readonly<Record<string, string>>;
  readonly workspace: string;
}): Promise<StandaloneProviderHost> {
  const { workspace } = options;
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-cassette-data-'));
  const env = {
    ...options.environment,
    LC_ALL: 'C',
    PATH: process.env['PATH'] ?? '',
    TZ: 'UTC',
    ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
  };
  const cli = (args: readonly string[]): Promise<CliResult> =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [bin, '--data-root', dataRoot, ...args],
        { cwd: tmpdir(), env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true },
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
  const started = await cli(['host', 'start', '--workspace', workspace]);
  if (started.code !== 0) {
    throw new Error(`The standalone host did not start: ${started.stderr || started.stdout}`);
  }
  const rows = async (threadId: string): Promise<readonly HostLogRow[]> => {
    const shown = await cli(['threads', 'show', '--thread', threadId]);
    if (shown.code !== 0) {
      throw new Error(`threads show failed: ${shown.stderr}`);
    }
    return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse(shown.stdout)).rows;
  };
  return {
    children: async (threadId) => {
      const listed = await cli(['children', 'list', '--thread', threadId]);
      if (listed.code !== 0) {
        throw new Error(`children list failed: ${listed.stderr}`);
      }
      return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/children'], {
        errors: 'all',
        onExcessProperty: 'error',
      })(JSON.parse(listed.stdout)).children.map((child) => child.threadId);
    },
    cli,
    async close() {
      const owner = RootLock.inspect(dataRoot)?.owner;
      if (owner && !owner.released) {
        const { pid } = decodeHostRecord(
          JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8'))
        );
        const stopped = await cli(['host', 'stop']);
        if (stopped.code !== 0) {
          throw new Error(`host stop failed: ${stopped.stderr}`);
        }
        for (let waited = 0; processStartTime(pid) !== null; waited += 100) {
          if (waited > 30_000) {
            throw new Error(`The standalone host ${pid} outlived host stop`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await rm(dataRoot, { force: true, recursive: true });
    },
    rows,
    async run(prompt, model) {
      const result = await cli(['run', prompt, '--model', model, '--json', '--non-interactive']);
      const identity = RunIdentity.safeParse(JSON.parse(result.stdout.split('\n')[0] || 'null'));
      if (!identity.success) {
        throw new Error(`run printed no identity (exit ${result.code}): ${result.stderr}`);
      }
      return { result, ...identity.data };
    },
    async startRun(prompt, model) {
      const thread = await cli(['thread', 'start']);
      const { threadId } = z.object({ threadId: z.string() }).parse(JSON.parse(thread.stdout));
      const startedRun = await cli([
        'run',
        'start',
        '--thread',
        threadId,
        '--model',
        model,
        '--prompt',
        prompt,
      ]);
      const { runId } = z.object({ runId: z.string() }).parse(JSON.parse(startedRun.stdout));
      return { runId, threadId };
    },
    workspace,
  };
}
/** Polls `read` until `found` holds, failing after `timeoutMs` with the last value. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  found: (value: T) => boolean,
  timeoutMs = 60_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!found(latest)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms; last value: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    latest = await read();
  }
  return latest;
}
