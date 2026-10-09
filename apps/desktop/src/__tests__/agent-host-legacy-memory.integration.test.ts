// @vitest-environment node
/**
 * Gap 17: the desktop's legacy workspace memory, written by the legacy PGlite
 * Mastra store, read by Main and carried over the private platform
 * connection, lands in the host StateStore once.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { PgliteMemoryStore } from '@brainstrike/agent/pglite-mastra-memory';
import { importLegacyMemory } from '@brainstrike/agent-host';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { migrate, readPgliteLegacyMemory, wasmLoader } from '@brainstrike/db';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { LEGACY_MEMORY_METHOD, serveLegacyMemory } from '../agent-host-platform/legacy-memory-main';

/** The same public MessageEvent shape as the Electron utility port, backed by real Node ports. */
class UtilityPort extends EventEmitter implements PlatformMessagePort {
  constructor(private readonly port: MessagePort) {
    super();
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}

const owned: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const release of owned.splice(0).reverse()) {
    await release();
  }
});

type LegacyDatabase = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

/** The desktop's PGlite with the shipped schema, and the legacy Mastra store over it. */
async function legacyProfile(): Promise<{ pg: LegacyDatabase; memory: PgliteMemoryStore }> {
  const pg = await wasmLoader.createPGlite('memory://legacy-workspace-memory');
  owned.push(() => pg.close());
  await migrate(pg);
  const memory = new PgliteMemoryStore({
    database: {
      exec: (sql) => pg.exec(sql),
      query: (sql, values) => pg.query(sql, values ? [...values] : undefined),
      transaction: (operation) =>
        pg.transaction((tx) =>
          operation({
            exec: (sql) => tx.exec(sql),
            query: (sql, values) => tx.query(sql, values ? [...values] : undefined),
          })
        ),
    },
  });
  await memory.init();
  return { memory, pg };
}

/** Main serves the read; the host side asks for it over the private platform connection. */
function platformRead(pg: LegacyDatabase): () => Promise<unknown> {
  const channel = new MessageChannel();
  const main = mainPlatformConnection(new UtilityPort(channel.port1));
  const node = mainPlatformConnection(new UtilityPort(channel.port2));
  const served = serveLegacyMemory(main, () =>
    readPgliteLegacyMemory(pg, WORKSPACE_MEMORY_RESOURCE_ID)
  );
  main.listen();
  node.listen();
  owned.push(() => {
    served.close();
    main.dispose();
    node.dispose();
    channel.port1.close();
    channel.port2.close();
  });
  return () => node.sendRequest(LEGACY_MEMORY_METHOD, {});
}

async function hostStore(): Promise<StateStore> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-legacy-memory-'));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const store = await StateStore.open(root);
  owned.push(() => store.close());
  return store;
}

test("the host imports Main's legacy workspace working memory once, and records its resource observations", async () => {
  const { memory, pg } = await legacyProfile();
  const createdAt = new Date('2026-09-01T08:00:00.000Z');
  const updatedAt = new Date('2026-09-30T08:00:00.000Z');
  await memory.saveResource({
    resource: {
      createdAt,
      id: WORKSPACE_MEMORY_RESOURCE_ID,
      metadata: { origin: 'legacy-fixture' },
      updatedAt,
      workingMemory: '# Notes\n- prefers tabs over spaces',
    },
  });
  await memory.initializeObservationalMemory({
    config: {},
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    scope: 'resource',
    threadId: null,
  });
  const legacy = await memory.getResourceById({ resourceId: WORKSPACE_MEMORY_RESOURCE_ID });
  const store = await hostStore();
  let reads = 0;
  const read = platformRead(pg);
  const counted = async (): Promise<unknown> => {
    reads += 1;
    return await read();
  };

  const marker = await importLegacyMemory(store, WORKSPACE_MEMORY_RESOURCE_ID, counted);
  expect(marker).toEqual({
    at: expect.any(String),
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    resourceObservations: true,
    workingMemory: 'imported',
  });
  // The host's record is the legacy native resource, dates as ISO text.
  const { entities } = await store.memory({
    operation: 'read',
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
  });
  expect(entities).toEqual([
    {
      id: WORKSPACE_MEMORY_RESOURCE_ID,
      kind: 'resource',
      payload: {
        createdAt: legacy?.createdAt.toISOString(),
        id: WORKSPACE_MEMORY_RESOURCE_ID,
        metadata: legacy?.metadata,
        updatedAt: legacy?.updatedAt.toISOString(),
        workingMemory: legacy?.workingMemory,
      },
      threadId: null,
    },
  ]);
  // Once marked, Main is never asked again.
  expect(await importLegacyMemory(store, WORKSPACE_MEMORY_RESOURCE_ID, counted)).toEqual(marker);
  expect(reads).toBe(1);
});

test('a profile with no legacy workspace memory records that there was nothing to import', async () => {
  const { pg } = await legacyProfile();
  const store = await hostStore();
  expect(await importLegacyMemory(store, WORKSPACE_MEMORY_RESOURCE_ID, platformRead(pg))).toEqual({
    at: expect.any(String),
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    resourceObservations: false,
    workingMemory: 'none',
  });
  expect(
    (await store.memory({ operation: 'read', resourceId: WORKSPACE_MEMORY_RESOURCE_ID })).entities
  ).toEqual([]);
});
