/**
 * BST-1880: `state/health/read` reports what the state store found when it
 * opened: its damage, when it opened the state DB read-only, and how many
 * records it could not read. Never their contents. The app's damaged-store
 * notice reads it, and reads it again after the host restarts.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import recording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost } from '../src/client.js';
import { storedHostEvent } from '../src/event-storage.js';
import { HostLogRowSchema } from '../src/protocol.js';
import { startAgentHost } from '../src/runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function seededRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-state-health-'));
  roots.push(root);
  const rows = Schema.decodeUnknownSync(Schema.Array(HostLogRowSchema), {
    onExcessProperty: 'error',
  })(recording);
  const store = await StateStore.open(root);
  await store.append(rows.map((row) => storedHostEvent(row.threadId, row.event)));
  await store.close();
  return root;
}

/** The i3-corruption proof's damage: one index cell, so the table pages still read. */
async function corruptRunEventIndex(root: string): Promise<void> {
  const file = join(root, 'state.db');
  const db = new DatabaseSync(file, { readOnly: true });
  let offset: number;
  try {
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.['page_size']);
    const leaf = Number(
      db
        .prepare(
          "SELECT pageno FROM dbstat WHERE name = 'sqlite_autoindex_run_events_1' AND pagetype = 'leaf' ORDER BY pageno"
        )
        .get()?.['pageno']
    );
    offset = leaf * pageSize - 3;
  } finally {
    db.close();
  }
  const bytes = await readFile(file);
  bytes[offset] = (bytes[offset] ?? 0) ^ 1;
  await writeFile(file, bytes);
}

async function withHost<T>(
  root: string,
  work: (client: Awaited<ReturnType<typeof attachAgentHost>>) => Promise<T>
): Promise<T> {
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: () => Promise.reject(new Error('A recorded log starts no run')),
      tools: {},
    }
  );
  const client = await attachAgentHost(host.record);
  try {
    return await work(client);
  } finally {
    await client.close();
    await host.close();
  }
}

function readHealth(root: string) {
  return withHost(root, async (client) => {
    const health = await client.request('state/health/read', {});
    const { threads } = await client.request('thread/list', {});
    return { damagedListed: threads.filter((thread) => thread.damage).length, health };
  });
}

test('a healthy state store reports no damage and no damaged threads', async () => {
  expect(await readHealth(await seededRoot())).toEqual({
    damagedListed: 0,
    health: { damagedThreads: 0, stateDamage: null },
  });
});

test('a damaged state DB reports its integrity failure, and reports it again after a restart', async () => {
  const root = await seededRoot();
  await corruptRunEventIndex(root);

  const first = await readHealth(root);
  expect(first.health.stateDamage).toMatch(/missing from index/);
  // The count is the catalog's own: every thread `thread/list` marks damaged.
  expect(first.health.damagedThreads).toBe(first.damagedListed);
  expect(await readHealth(root)).toEqual(first);
});

test('a damaged state DB refuses writes as a typed read-only refusal and keeps serving reads (BST-2144)', async () => {
  const root = await seededRoot();
  await corruptRunEventIndex(root);

  await withHost(root, async (client) => {
    await expect(client.catalog.modelChoices({ operation: 'snapshot' })).resolves.toMatchObject({
      models: [],
    });
    const refusal = {
      failure: { category: 'availability', code: 'state.read-only', kind: 'refusal' },
    };
    await expect(
      client.catalog.modelChoices({ enabled: true, operation: 'provider', providerId: 'openai' })
    ).rejects.toMatchObject(refusal);
    // A new thread's first append is refused because the store is, not the thread.
    await expect(
      client.request('thread/start', { commandId: crypto.randomUUID() })
    ).rejects.toMatchObject(refusal);
  });
});
