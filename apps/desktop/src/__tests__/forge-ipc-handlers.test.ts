import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ForgePrStatus, ForgeResult } from '@brainstrike/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeIdentityState, ForgeService } from '../assistant-server/forge-service';
import { createForgeIpcHandlers, createForgeRepositoryResolver } from '../forge-ipc-handlers';
import { execFileGitRunner } from '../git-ipc-handlers';

vi.mock('../git-ipc-handlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-ipc-handlers')>();
  return { ...actual, execFileGitRunner: vi.fn() };
});

const status: ForgePrStatus = { kind: 'none', observedAt: '2026-08-24T00:00:00.000Z' };
const temporaryDirectories: string[] = [];

function service(overrides: Partial<ForgeService> = {}): ForgeService {
  return {
    identity: vi.fn(
      async (): Promise<ForgeResult<ForgeIdentityState>> => ({
        ok: true,
        value: { failure: null, identity: null, repoCommonDir: '/repo/.git' },
      })
    ),
    onRepositoryInvalidated: vi.fn(),
    prStatus: vi.fn(async () => ({ ok: true, value: status }) as ForgeResult<ForgePrStatus>),
    refresh: vi.fn(async () => ({ ok: true, value: status }) as ForgeResult<ForgePrStatus>),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('createForgeIpcHandlers', () => {
  it('rejects a non-string rootId without touching the service', async () => {
    const forge = service();
    const handlers = createForgeIpcHandlers({ service: forge });
    await expect(handlers.prStatus(42)).resolves.toEqual({
      error: 'forge requires a non-empty rootId string',
      ok: false,
    });
    expect(forge.prStatus).not.toHaveBeenCalled();
  });

  it('rejects an empty rootId', async () => {
    const handlers = createForgeIpcHandlers({ service: service() });
    await expect(handlers.identity('   ')).resolves.toEqual({
      error: 'forge requires a non-empty rootId string',
      ok: false,
    });
  });

  it('rejects an unrecognized refresh reason instead of defaulting one', async () => {
    const forge = service();
    const handlers = createForgeIpcHandlers({ service: forge });
    await expect(handlers.refresh('root-1', { reason: 'whenever' })).resolves.toEqual({
      error: 'forge refresh requires reason "invalidation", "user" or "window"',
      ok: false,
    });
    expect(forge.refresh).not.toHaveBeenCalled();
  });

  it('refuses a renderer-supplied "shell" refresh reason', async () => {
    const forge = service();
    const handlers = createForgeIpcHandlers({ service: forge });
    const result = await handlers.refresh('root-1', { reason: 'shell' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('"invalidation", "user" or "window"');
    expect(forge.refresh).not.toHaveBeenCalled();
  });

  it('forwards a valid refresh', async () => {
    const forge = service();
    const handlers = createForgeIpcHandlers({ service: forge });
    await expect(handlers.refresh('root-1', { reason: 'user' })).resolves.toEqual({
      ok: true,
      value: status,
    });
    expect(forge.refresh).toHaveBeenCalledWith('root-1', 'user');
  });

  it('converts a service throw into an error result, never a rejected IPC call', async () => {
    const handlers = createForgeIpcHandlers({
      service: service({
        prStatus: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    });
    await expect(handlers.prStatus('root-1')).resolves.toEqual({ error: 'boom', ok: false });
  });
});

describe('createForgeRepositoryResolver', () => {
  it('uses only the canonical cwd returned by workspace-root resolution for every git call', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'forge-ipc-'));
    temporaryDirectories.push(directory);
    const root = path.join(directory, 'workspace');
    const commonDir = path.join(root, '.git');
    await mkdir(commonDir, { recursive: true });
    const canonicalRoot = await realpath(root);
    const canonicalCommonDir = await realpath(commonDir);
    const run = vi.mocked(execFileGitRunner);
    run.mockImplementation(async ({ args, cwd }) => {
      expect(cwd).toBe(canonicalRoot);
      const command = args.join(' ');
      if (command === 'rev-parse --path-format=absolute --git-common-dir') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: `${canonicalCommonDir}\n`,
          timedOut: false,
        };
      }
      if (command === 'symbolic-ref --quiet --short HEAD') {
        return { exitCode: 0, stderr: '', stdout: 'feature/forge\n', timedOut: false };
      }
      if (command === 'remote') {
        return { exitCode: 0, stderr: '', stdout: 'origin\n', timedOut: false };
      }
      if (command === 'config --get branch.feature/forge.remote') {
        return { exitCode: 0, stderr: '', stdout: 'origin\n', timedOut: false };
      }
      if (command === 'remote get-url origin') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'git@github.com:brainstrike/widgets.git\n',
          timedOut: false,
        };
      }
      throw new Error(`Unexpected git command: ${command}`);
    });
    const resolver = createForgeRepositoryResolver({
      listRoots: async () => [{ displayName: 'Workspace', path: root, rootId: 'root-1' }],
    });

    await expect(resolver('root-1')).resolves.toEqual({
      ok: true,
      value: {
        context: {
          branch: 'feature/forge',
          commonDir: canonicalCommonDir,
          remoteReason: null,
          remoteUrl: 'git@github.com:brainstrike/widgets.git',
        },
        cwd: canonicalRoot,
      },
    });
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('returns a root-resolution error without running git', async () => {
    const resolver = createForgeRepositoryResolver({ listRoots: async () => [] });

    await expect(resolver('missing-root')).resolves.toEqual({
      error: 'No open folder matches root id "missing-root".',
      ok: false,
    });
    expect(execFileGitRunner).not.toHaveBeenCalled();
  });
});

describe('createForgeRepositoryResolver — resolution cache (BST-1391 review, S4)', () => {
  async function setupCachedResolverFixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'forge-ipc-cache-'));
    temporaryDirectories.push(directory);
    const root = path.join(directory, 'workspace');
    const commonDir = path.join(root, '.git');
    await mkdir(commonDir, { recursive: true });
    const canonicalCommonDir = await realpath(commonDir);
    const run = vi.mocked(execFileGitRunner);
    run.mockImplementation(async ({ args }) => {
      const command = args.join(' ');
      if (command === 'rev-parse --path-format=absolute --git-common-dir') {
        return { exitCode: 0, stderr: '', stdout: `${canonicalCommonDir}\n`, timedOut: false };
      }
      if (command === 'symbolic-ref --quiet --short HEAD') {
        return { exitCode: 0, stderr: '', stdout: 'main\n', timedOut: false };
      }
      if (command === 'remote') {
        return { exitCode: 0, stderr: '', stdout: 'origin\n', timedOut: false };
      }
      if (command === 'config --get branch.main.remote') {
        return { exitCode: 0, stderr: '', stdout: 'origin\n', timedOut: false };
      }
      if (command === 'remote get-url origin') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'git@github.com:brainstrike/widgets.git\n',
          timedOut: false,
        };
      }
      throw new Error(`Unexpected git command: ${command}`);
    });
    const resolver = createForgeRepositoryResolver({
      listRoots: async () => [{ displayName: 'Workspace', path: root, rootId: 'root-1' }],
    });
    return { canonicalCommonDir, resolver, run };
  }

  it('caches a resolution: a second call for the same rootId does not re-run git', async () => {
    const { resolver, run } = await setupCachedResolverFixture();

    const first = await resolver('root-1');
    const second = await resolver('root-1');

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('invalidateResolverCache(commonDir) clears the cache, forcing a re-resolve', async () => {
    const { canonicalCommonDir, resolver, run } = await setupCachedResolverFixture();

    await resolver('root-1');
    expect(run).toHaveBeenCalledTimes(5);

    resolver.invalidateResolverCache(canonicalCommonDir);
    await resolver('root-1');

    expect(run).toHaveBeenCalledTimes(10);
  });

  it('invalidateResolverCache with an unrelated commonDir leaves the cache intact', async () => {
    const { resolver, run } = await setupCachedResolverFixture();

    await resolver('root-1');
    expect(run).toHaveBeenCalledTimes(5);

    resolver.invalidateResolverCache('/some/other/repo/.git');
    await resolver('root-1');

    expect(run).toHaveBeenCalledTimes(5);
  });
});
