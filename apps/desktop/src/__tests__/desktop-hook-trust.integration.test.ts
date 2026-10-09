// @vitest-environment node
/**
 * The one-time import of the retired renderer hook approvals into the host:
 * an approval becomes host trust only where its file still matches, a changed
 * or rootless one stays untrusted, and the slice is retired only after every
 * entry settled. The slice fixture is the store's recorded persisted payload.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  type HostPlatform,
  startAgentHost,
} from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import {
  createDesktopHookTrust,
  type DesktopHookTrustOptions,
  LEGACY_HOOK_TRUST_STORAGE_KEY,
} from '../desktop-hook-trust';

const dirs: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

const platform: HostPlatform = {
  close: async () => undefined,
  maxSteps: 1,
  readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  resolveModel: async () => {
    throw new Error('Hook trust never resolves a model');
  },
  tools: {},
};

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bs-desktop-hook-trust-'));
  dirs.push(dir);
  return dir;
}

async function hostClient(): Promise<HostClient> {
  const host = await startAgentHost({ lifetime: 'persistent', root: await tempDir() }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return client;
}

async function workspaceWithHooks(content: string): Promise<string> {
  const workspace = await tempDir();
  await mkdir(join(workspace, '.brainstrike'));
  await writeFile(join(workspace, '.brainstrike', 'hooks.json'), content);
  return workspace;
}

const sha256Of = (content: string): string => createHash('sha256').update(content).digest('hex');

/** The recorded slice, its two approvals re-pointed at this test's file hashes. */
async function legacySlice(hashes: Readonly<Record<string, string>>): Promise<string> {
  const recorded = JSON.parse(
    await readFile(join(import.meta.dirname, 'fixtures', 'legacy-hook-trust-slice.json'), 'utf8')
  ) as { state: { approvalsByRootId: Record<string, { approvedAt: number; sha256: string }> } };
  const approvals = recorded.state.approvalsByRootId;
  for (const [rootId, sha256] of Object.entries(hashes)) {
    approvals[rootId] = { approvedAt: approvals['db-root-trusted']?.approvedAt ?? 0, sha256 };
  }
  return JSON.stringify(recorded);
}

function memoryStorage(initial: string | null) {
  const items = new Map<string, string>();
  if (initial !== null) {
    items.set(LEGACY_HOOK_TRUST_STORAGE_KEY, initial);
  }
  let reads = 0;
  return {
    getItem: async (key: string) => {
      reads += 1;
      return items.get(key) ?? null;
    },
    has: (key: string) => items.has(key),
    get reads(): number {
      return reads;
    },
    removeItem: async (key: string) => {
      items.delete(key);
    },
  };
}

test('an earlier approval becomes host trust only where its file still matches', async () => {
  const client = await hostClient();
  const trusted = await workspaceWithHooks('{"PreToolUse":[]}');
  const changed = await workspaceWithHooks('{"Stop":[]}');
  const storage = memoryStorage(
    await legacySlice({
      'db-root-changed': sha256Of('{"Stop":[{"type":"command","command":"true"}]}'),
      'db-root-gone': sha256Of('{}'),
      'db-root-trusted': sha256Of('{"PreToolUse":[]}'),
    })
  );
  const hookTrust = createDesktopHookTrust({
    loadRootPaths: async () =>
      new Map([
        ['db-root-changed', changed],
        ['db-root-trusted', trusted],
      ]),
    request: (method, params) => client.request(method, params),
    storage,
  });

  await hookTrust.imported();

  await expect(client.request('hooks/trust/read', { rootId: 'db-root-trusted' })).resolves.toEqual({
    trust: { path: trusted, sha256: sha256Of('{"PreToolUse":[]}') },
  });
  await expect(client.request('hooks/trust/read', { rootId: 'db-root-changed' })).resolves.toEqual({
    trust: null,
  });
  await expect(client.request('hooks/trust/read', { rootId: 'db-root-gone' })).resolves.toEqual({
    trust: null,
  });
  expect(storage.has(LEGACY_HOOK_TRUST_STORAGE_KEY)).toBe(false);

  // Reads apply the same-path rule, and the import never runs twice.
  await expect(hookTrust.approval({ absPath: trusted, rootId: 'db-root-trusted' })).resolves.toBe(
    sha256Of('{"PreToolUse":[]}')
  );
  await expect(
    hookTrust.approval({ absPath: changed, rootId: 'db-root-trusted' })
  ).resolves.toBeUndefined();
  expect(storage.reads).toBe(1);
});

test('an import the host could not record keeps the slice and runs again', async () => {
  const client = await hostClient();
  const trusted = await workspaceWithHooks('{"PreToolUse":[]}');
  const storage = memoryStorage(
    await legacySlice({ 'db-root-trusted': sha256Of('{"PreToolUse":[]}') })
  );
  let lost = true;
  const request: DesktopHookTrustOptions['request'] = (method, params) => {
    if (lost) {
      lost = false;
      return Promise.reject(new Error('Host connection lost'));
    }
    return client.request(method, params);
  };
  const hookTrust = createDesktopHookTrust({
    loadRootPaths: async () => new Map([['db-root-trusted', trusted]]),
    request,
    storage,
  });

  await expect(hookTrust.imported()).rejects.toThrow(
    'Earlier hook approvals could not be imported into the agent host'
  );
  expect(storage.has(LEGACY_HOOK_TRUST_STORAGE_KEY)).toBe(true);

  await hookTrust.imported();
  await expect(hookTrust.approval({ absPath: trusted, rootId: 'db-root-trusted' })).resolves.toBe(
    sha256Of('{"PreToolUse":[]}')
  );
  expect(storage.has(LEGACY_HOOK_TRUST_STORAGE_KEY)).toBe(false);
});

test('a slice from before DB root ids, or an unreadable one, is retired with nothing trusted', async () => {
  for (const raw of ['{"state":{"approvalsByRootId":{"adapter-id":{}}},"version":1}', 'not json']) {
    const storage = memoryStorage(raw);
    const hookTrust = createDesktopHookTrust({
      loadRootPaths: () => Promise.reject(new Error('No root is read for an empty import')),
      request: () => Promise.reject(new Error('No host request for an empty import')),
      storage,
    });
    await hookTrust.imported();
    expect(storage.has(LEGACY_HOOK_TRUST_STORAGE_KEY)).toBe(false);
  }
});
