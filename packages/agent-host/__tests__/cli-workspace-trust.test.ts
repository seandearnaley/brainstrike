/**
 * `workspace trust` (ADR-0032): the CLI trusts a folder only on the person's
 * explicit yes, and adds the folder's parent as a trusted location only when
 * they pass the flag that asks for it.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { trustCliWorkspace } from '../src/cli-workspace-trust.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/** A folder kept in `code`, by real paths, the spelling the host keeps trust under. */
async function clonedFolder(): Promise<{ readonly cloned: string; readonly code: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'bs-cli-workspace-trust-')));
  dirs.push(base);
  const cloned = join(base, 'code', 'cloned');
  await mkdir(cloned, { recursive: true });
  return { cloned, code: join(base, 'code') };
}

/**
 * A host that records what the CLI asked of it. `offeredLocation` is the
 * parent it would record for the folder, as `workspace/trust/read` names it.
 */
function recordingHost(offeredLocation?: string) {
  const requests: unknown[] = [];
  return {
    client: {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return method === 'workspace/trust/read'
          ? { ...(offeredLocation === undefined ? {} : { offeredLocation }), trust: 'undecided' }
          : { trust: 'trusted' };
      },
    } as Parameters<typeof trustCliWorkspace>[0],
    requests,
  };
}

/** The requests that record something, leaving out what the CLI only read. */
const recorded = (requests: readonly unknown[]): unknown[] =>
  requests.filter(
    (request) => (request as { readonly method: string }).method !== 'workspace/trust/read'
  );

test('trusting a folder asks the host for that folder alone', async () => {
  const { cloned } = await clonedFolder();
  const host = recordingHost();

  await expect(
    trustCliWorkspace(host.client, { interactive: false, root: cloned, yes: true })
  ).resolves.toEqual({ path: cloned, trust: 'trusted' });

  expect(host.requests).toEqual([
    { method: 'workspace/trust', params: { path: cloned, trust: 'trusted' } },
  ]);
});

test("--trust-parent also names the folder's parent as a trusted location, and reports it", async () => {
  const { cloned, code } = await clonedFolder();
  const host = recordingHost(code);

  await expect(
    trustCliWorkspace(host.client, {
      interactive: false,
      root: `${cloned}/`,
      trustParent: true,
      yes: true,
    })
  ).resolves.toEqual({ location: code, path: cloned, trust: 'trusted' });

  expect(recorded(host.requests)).toEqual([
    { method: 'workspace/trust', params: { location: code, path: cloned, trust: 'trusted' } },
  ]);
});

test('--trust-parent names the parent the host offers, which for a worktree is where its repository is kept', async () => {
  // The folder is a managed worktree: its answer is its repository's, kept somewhere else.
  const { cloned: worktree } = await clonedFolder();
  const { code: repositories } = await clonedFolder();
  const host = recordingHost(repositories);

  await expect(
    trustCliWorkspace(host.client, { interactive: false, root: worktree, trustParent: true })
  ).rejects.toThrow(
    `Review ${worktree} and every folder in ${repositories}, then trust them with --yes --trust-parent`
  );
  await expect(
    trustCliWorkspace(host.client, {
      interactive: false,
      root: worktree,
      trustParent: true,
      yes: true,
    })
  ).resolves.toEqual({ location: repositories, path: worktree, trust: 'trusted' });

  expect(recorded(host.requests)).toEqual([
    {
      method: 'workspace/trust',
      params: { location: repositories, path: worktree, trust: 'trusted' },
    },
  ]);
});

test('--trust-parent trusts nothing when the host offers no parent', async () => {
  const { cloned } = await clonedFolder();
  const host = recordingHost();

  await expect(
    trustCliWorkspace(host.client, {
      interactive: false,
      root: cloned,
      trustParent: true,
      yes: true,
    })
  ).rejects.toThrow(/Run without --trust-parent/u);

  expect(recorded(host.requests)).toEqual([]);
});

test('without a terminal nothing is trusted unless --yes confirms it, and the refusal names what would be', async () => {
  const { cloned, code } = await clonedFolder();
  const host = recordingHost(code);

  await expect(
    trustCliWorkspace(host.client, { interactive: false, root: cloned })
  ).rejects.toThrow(`Review ${cloned}, then trust it with --yes`);
  await expect(
    trustCliWorkspace(host.client, { interactive: false, root: cloned, trustParent: true })
  ).rejects.toThrow(
    `Review ${cloned} and every folder in ${code}, then trust them with --yes --trust-parent`
  );

  expect(recorded(host.requests)).toEqual([]);
});
