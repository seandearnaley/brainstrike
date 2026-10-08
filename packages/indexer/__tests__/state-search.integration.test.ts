import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import { expect, it } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };

it('searches committed text across the requested threads with literal, bounded, ranked terms', async () => {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'state-search-')));
  const options = {
    dbPath: path.join(root, 'state-index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: [],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/core-state-projection.mjs', import.meta.url).href,
    },
    stateRoot: root,
  } as const;
  const port = await openIndexer(options, deadlines);
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  try {
    const first = recording[0]?.threadId;
    const started = recording.find((row) => row.event.type === 'run.started');
    if (!(first && started)) {
      throw new Error('The recorded Core run is required');
    }
    const second = 'second-recorded-thread';
    const unrequested = 'unrequested-recorded-thread';
    await store.append(
      [first, second, unrequested].flatMap((threadId) =>
        recording.map((row) => ({ event: row.event, threadId }))
      )
    );

    const hits = await port.searchState({
      limit: 10,
      query: 'fixture tool',
      threads: [first, second],
    });
    expect(hits).toEqual(
      expect.arrayContaining(
        [first, second].map((threadId) => ({
          seq: started.seq,
          snippet: expect.stringContaining('fixture tool'),
          threadId,
        }))
      )
    );
    expect(hits.map((hit) => hit.threadId)).not.toContain(unrequested);

    // User text is literal terms, never FTS5 query syntax: as syntax this is an
    // unbalanced group; as terms it requires a word no row contains.
    await expect(
      port.searchState({ limit: 10, query: 'fixture" NOT (zzqx', threads: [first] })
    ).resolves.toEqual([]);
    expect(
      await port.searchState({ limit: 1, query: 'fixture', threads: [first, second] })
    ).toHaveLength(1);
    expect(await port.searchState({ limit: 10, query: 'fixture', threads: [] })).toEqual([]);
  } finally {
    await store.close();
    await port.close();
    await rm(root, { force: true, recursive: true });
  }
});
