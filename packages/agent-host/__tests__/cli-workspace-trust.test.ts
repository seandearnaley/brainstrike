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

/** A host that records what the CLI asked of it. */
function recordingHost() {
  const requests: unknown[] = [];
  return {
    client: {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return { trust: 'trusted' };
      },
    } as Parameters<typeof trustCliWorkspace>[0],
    requests,
  };
}

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
  const host = recordingHost();

  await expect(
    trustCliWorkspace(host.client, {
      interactive: false,
      root: `${cloned}/`,
      trustParent: true,
      yes: true,
    })
  ).resolves.toEqual({ location: code, path: cloned, trust: 'trusted' });

  expect(host.requests).toEqual([
    { method: 'workspace/trust', params: { location: code, path: cloned, trust: 'trusted' } },
  ]);
});

test('without a terminal nothing is trusted unless --yes confirms it, and the refusal names what would be', async () => {
  const { cloned, code } = await clonedFolder();
  const host = recordingHost();

  await expect(
    trustCliWorkspace(host.client, { interactive: false, root: cloned })
  ).rejects.toThrow(`Review ${cloned}, then trust it with --yes`);
  await expect(
    trustCliWorkspace(host.client, { interactive: false, root: cloned, trustParent: true })
  ).rejects.toThrow(
    `Review ${cloned} and every folder in ${code}, then trust them with --yes --trust-parent`
  );

  expect(host.requests).toEqual([]);
});
