/** Real host log + real shadow Git; only the provider and reindex effect are test-owned. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  attachAgentHost,
  type HostPlatform,
  type HostTool,
  type HostTurnBoundaryRequest,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect } from 'vitest';
import { z } from 'zod';
import { createHostRewindFiles } from '../../agent-host-platform/host-rewind-files';
import { createHostThreadTurns } from '../../assistant-server/changeset-host-turns';
import { createSnapshotChangesetResolver } from '../../assistant-server/changeset-snapshot-view';
import { execFileSnapshotGitRunner } from '../../assistant-server/snapshot-git';
import { FAILED_SNAPSHOT_CAPTURE_OID } from '../../assistant-server/snapshot-repository';
import { createSnapshotService } from '../../assistant-server/snapshot-service';
import { captureRootSnapshot } from '../../assistant-server/snapshot-turn-boundaries';
import { createHostRewindPort } from '../../renderer/host-rewind-port';

const exec = promisify(execFile);
export const cleanup: (() => Promise<void>)[] = [];
export async function cleanHostFixtures(): Promise<void> {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
}
export async function write(root: string, relative: string, content: string): Promise<void> {
  const file = join(root, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}
export async function read(root: string, relative: string): Promise<string | null> {
  try {
    return await readFile(join(root, relative), 'utf8');
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return null;
    }
    throw cause;
  }
}
export async function hostSnapshotFixture(
  options: {
    capture?: boolean;
    failedRoot?: string;
    captureFailure?: boolean;
    approval?: boolean;
  } = {}
) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'bs-host-snapshot-')));
  cleanup.push(() => rm(base, { force: true, recursive: true }));
  const roots = ['a', 'b', 'c'].map((id) => ({ rootId: `root-${id}`, rootPath: join(base, id) }));
  for (const root of roots) {
    await mkdir(root.rootPath);
  }
  const [a, b, c] = roots;
  if (!(a && b && c)) {
    throw new Error('Three roots are required');
  }
  for (const root of [a, b]) {
    await exec('git', ['init', '-q'], { cwd: root.rootPath });
    await exec('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: root.rootPath });
    await exec('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: root.rootPath });
    await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: root.rootPath });
  }
  await write(a.rootPath, 'src/index.ts', 'a-v0\n');
  await write(b.rootPath, 'src/index.ts', 'b-v0\n');
  await write(c.rootPath, 'notes/scratch.md', 'c-v0\n');
  await exec('git', ['add', '-A'], { cwd: a.rootPath });
  await exec('git', ['commit', '-qm', 'init'], { cwd: a.rootPath });
  const service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: join(base, 'shadow'),
  });
  const mounted = new Set(roots.map((root) => root.rootId));
  const reindexed: unknown[] = [];
  let disconnectOnApply = false;
  const files = createHostRewindFiles({
    refreshWorkspaceIndex: async (rootId) => {
      reindexed.push(rootId);
    },
    resolveWorkspaceRoot: async (rootId) => {
      const root = roots.find((item) => item.rootId === rootId);
      if (!(root && mounted.has(rootId))) {
        throw new Error('The workspace root is no longer mounted');
      }
      return root.rootPath;
    },
    snapshots: () => service,
  });
  let perform: () => Promise<void> = async () => undefined;
  const platform: HostPlatform = {
    admitRun: async () => {
      const step = perform;
      const tools: Readonly<Record<string, HostTool>> = options.approval
        ? {
            write_fixture: {
              description: 'recorded workspace write',
              execute: async () => {
                await step();
                return { ok: true };
              },
              identity: 'write-fixture-v1',
              inputSchema: z.object({ text: z.string() }),
              risk: 'edit',
            },
          }
        : {};
      const model = scriptedModel(options.approval ? 'write_fixture' : undefined);
      if (!options.approval) {
        const stream = model.doStream.bind(model);
        model.doStream = async (args) => {
          await step();
          return await stream(args);
        };
      }
      return {
        ...(options.capture === false
          ? {}
          : {
              captureTurnBoundary: async (request: HostTurnBoundaryRequest) => {
                if (options.captureFailure) {
                  throw new Error('recorded snapshot owner unavailable');
                }
                const captured = [];
                for (const root of roots) {
                  const outcome = await captureRootSnapshot(
                    service,
                    request.boundary,
                    request.threadId,
                    request.runId,
                    {
                      path:
                        options.failedRoot === root.rootId
                          ? join(root.rootPath, 'missing')
                          : root.rootPath,
                      rootId: root.rootId,
                    }
                  );
                  captured.push({
                    commitOid:
                      outcome.kind === 'captured' ? outcome.commitOid : FAILED_SNAPSHOT_CAPTURE_OID,
                    rootId: root.rootId,
                    rootPath: outcome.rootPath,
                  });
                }
                return captured;
              },
            }),
        configuration: {},
        model,
        snapshot: {
          configuration: {},
          maxSteps: 2,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([name, tool]) => [name, tool.identity])
          ),
        },
        tools,
      };
    },
    close: async () => undefined,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' },
      yolo: false,
    }),
    rewindFiles: {
      ...files,
      drift: async (request) => {
        const result = await files.drift(request);
        if (disconnectOnApply) {
          mounted.delete('root-b');
        }
        return result;
      },
    },
  };
  let host = await startAgentHost({ lifetime: 'persistent', root: join(base, 'host') }, platform);
  let client = await attachAgentHost(host.record);
  cleanup.push(async () => {
    await client.close();
    await host.close();
  });
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const requestedSeqs: number[] = [];
  const turns = () =>
    createHostThreadTurns({
      listThreads: async () =>
        new Set((await client.request('thread/list', {})).threads.map((thread) => thread.threadId)),
      readRows: async (id, fromSeq) => {
        requestedSeqs.push(fromSeq);
        return (await client.request('thread/read', { fromSeq, threadId: id })).rows;
      },
    });
  const resolver = () =>
    createSnapshotChangesetResolver({ hostThreads: turns(), resolveService: () => service });
  const activeResolver = resolver();
  const port = createHostRewindPort(
    { request: (...args) => client.request(...args) },
    {
      fileDiff: (rootId, changeset, path) => {
        if (changeset.kind === 'git-scope') {
          throw new Error('Host turn required');
        }
        return activeResolver.fileDiff(rootId, changeset, path);
      },
      resolveView: (_rootId, changeset) => {
        if (changeset.kind === 'git-scope') {
          throw new Error('Host turn required');
        }
        return activeResolver.resolveView(changeset);
      },
    }
  );
  const rows = async () => (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
  const terminals = new Map<string, Promise<void>>();
  const settled = async (runId: string) => {
    const terminal = terminals.get(runId);
    if (!terminal) {
      throw new Error('No admitted run owns this completion');
    }
    await terminal;
    expect(
      (await rows()).some(({ event }) => event.type === 'run.finished' && event.runId === runId)
    ).toBe(true);
  };
  const start = async (work: () => Promise<void> = async () => undefined) => {
    perform = work;
    const terminal = Promise.withResolvers<void>();
    const unsubscribe = host.core.onCommitted((row) => {
      if (row.threadId === threadId && row.event.type === 'run.finished') {
        terminal.resolve();
      }
    });
    try {
      const commandId = randomUUID();
      const { runId } = await client.request('run/start', {
        commandId,
        modelId: 'scripted',
        prompt: 'Recorded test turn',
        threadId,
      });
      terminals.set(runId, terminal.promise.finally(unsubscribe));
      return { messageId: commandId, runId };
    } catch (cause) {
      unsubscribe();
      throw cause;
    }
  };
  const send = async (work?: () => Promise<void>) => {
    const run = await start(work);
    await settled(run.runId);
    return run;
  };
  return {
    a: a.rootPath,
    b: b.rootPath,
    c: c.rootPath,
    client: () => client,
    loseRootAfterDrift: () => {
      disconnectOnApply = true;
    },
    mounted,
    onCommitted: (listener: Parameters<typeof host.core.onCommitted>[0]) =>
      host.core.onCommitted(listener),
    port,
    reindexed,
    reopen: async () => {
      await client.close();
      await host.close();
      host = await startAgentHost({ lifetime: 'persistent', root: join(base, 'host') }, platform);
      client = await attachAgentHost(host.record);
    },
    requestedSeqs,
    resolver,
    roots,
    rows,
    send,
    service,
    settled,
    start,
    threadId,
    turns,
  };
}
export type HostSnapshotFixture = Awaited<ReturnType<typeof hostSnapshotFixture>>;
export async function editAll(f: HostSnapshotFixture): Promise<void> {
  await write(f.a, 'src/index.ts', 'a-v1\n');
  await write(f.b, 'src/index.ts', 'b-v1\n');
  await write(f.c, 'notes/scratch.md', 'c-v1\n');
  await write(f.c, 'notes/generated.lock', 'shell wrote this\n');
}
