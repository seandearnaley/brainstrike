/**
 * The standalone `brainstrike` host over a disposable data root and workspace,
 * with every provider base-URL knob pointed at one loopback server (the
 * model-provider shim, or the cassette recorder). It runs in this process, as
 * the CLI runs it: the production platform, real HostCore, real provider SDKs;
 * the committed log is read back through the host's client as any client reads it.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { openStandaloneHost } from '@brainstrike/agent-host/standalone-host';

const require = createRequire(import.meta.url);
/** The production executable's platform, as `bin/brainstrike.mjs` composes it. */
const platformModule = join(
  dirname(require.resolve('@brainstrike/host-capabilities')),
  'platform.ts'
);
export interface StandaloneProviderHost {
  /** Child thread ids of `threadId`, in the host's order. */
  readonly children: (threadId: string) => Promise<readonly string[]>;
  readonly close: () => Promise<void>;
  readonly rows: (threadId: string) => Promise<readonly HostLogRow[]>;
  /** A run on a new thread, awaited until it ends or asks for a decision. */
  readonly run: (
    prompt: string,
    model: string
  ) => Promise<{
    readonly runId: string;
    readonly threadId: string;
  }>;
  /** A run on a new thread that proceeds while the caller watches. */
  readonly startRun: (
    prompt: string,
    model: string
  ) => Promise<{
    readonly runId: string;
    readonly threadId: string;
  }>;
  /** Stops a run, as a person's Stop does. */
  readonly stop: (threadId: string, runId: string) => Promise<void>;
  /** Every root thread id, in the host's order. */
  readonly threads: () => Promise<readonly string[]>;
  readonly workspace: string;
}
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
/** Sets `entries` in this process's environment and returns the restore of what they replaced. */
function overlayEnvironment(entries: Readonly<Record<string, string>>): () => void {
  const previous = Object.entries(entries).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, entries);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}
/**
 * `environment` is the host's provider environment: base-URL knobs and
 * credentials, in this process's environment while the host is open.
 */
export async function startStandaloneProviderHost(options: {
  readonly environment: Readonly<Record<string, string>>;
  readonly workspace: string;
}): Promise<StandaloneProviderHost> {
  const { workspace } = options;
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-cassette-data-'));
  const restore = overlayEnvironment({ ...options.environment, LC_ALL: 'C', TZ: 'UTC' });
  let host: Awaited<ReturnType<typeof openStandaloneHost>>;
  try {
    host = await openStandaloneHost(join(dataRoot, 'root'), platformModule, {
      workspaceRoots: [workspace],
    });
  } catch (cause) {
    restore();
    await rm(dataRoot, { force: true, recursive: true });
    throw cause;
  }
  const { client } = host;
  const rows = async (threadId: string): Promise<readonly HostLogRow[]> =>
    (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
  const startRun = async (prompt: string, modelId: string) => {
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId,
      prompt,
      threadId,
    });
    return { runId, threadId };
  };
  return {
    children: async (threadId) =>
      (await client.request('thread/children', { threadId })).children.map(
        (child) => child.threadId
      ),
    async close() {
      try {
        await host.close();
      } finally {
        restore();
        await rm(dataRoot, { force: true, recursive: true });
      }
    },
    rows,
    async run(prompt, model) {
      const started = await startRun(prompt, model);
      const ended = ({ event }: HostLogRow): boolean =>
        (event.type === 'run.finished' || event.type === 'interaction.requested') &&
        event.runId === started.runId;
      const settled = Promise.withResolvers<void>();
      const release = client.onEvent((row) => {
        if (row.threadId === started.threadId && ended(row)) {
          settled.resolve();
        }
      });
      try {
        const replayed = await client.request('log/subscribe', {
          fromSeq: 0,
          threadId: started.threadId,
        });
        if (replayed.rows.some(ended)) {
          settled.resolve();
        }
        await settled.promise;
      } finally {
        release();
        await client.request('log/unsubscribe', { threadId: started.threadId });
      }
      return started;
    },
    startRun,
    async stop(threadId, runId) {
      await client.request('run/stop', { commandId: randomUUID(), runId, threadId });
    },
    threads: async () =>
      (await client.request('thread/list', {})).threads.map((thread) => thread.threadId),
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
