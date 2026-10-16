import {
  WEB_STATE_PROTOCOL,
  webStateNames,
  webStateWireProtocol,
} from '@brainstrike/web-state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { DERIVED_INDEX_EXTENSION_ID } from '../derived-index-extension';
import { WebDerivedIndex } from '../web-writer-client';
import { closeTabs, corpus, openTab, storeConfig, storeCorpus } from './writer-tabs';

afterEach(closeTabs);

describe('the derived index in the browser writer', () => {
  it('projects the committed runs, including the blobs they name, and serves history search', async () => {
    expect(corpus.blobs.length).toBeGreaterThan(0);
    const tab = await openTab(storeConfig());
    await storeCorpus(tab);
    const index = new WebDerivedIndex(tab);
    expect(await index.catchUp()).toBe(true);

    const prompts = await index.search({
      limit: 10,
      query: 'canonical human interaction',
      threadIds: corpus.threadIds,
    });
    expect(prompts.map((hit) => hit.role)).toContain('user');
    expect(prompts[0]?.snippet).toContain('<mark>');
    const runs = await index.search({
      limit: 10,
      query: 'rich committed run',
      threadIds: corpus.threadIds,
    });
    expect(new Set(runs.map((hit) => hit.runId)).size).toBe(2);

    // The run snapshot the plan run spooled is named by its projected row.
    const counts = await index.gcCheck(
      corpus.threadIds,
      corpus.blobs.map(([hash]) => hash)
    );
    expect(Object.values(counts).every((count) => count > 0)).toBe(true);
  });

  it('serves a follower tab through the writer, and keeps its projection across a reload', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    await storeCorpus(follower);
    await new WebDerivedIndex(follower).catchUp();
    writer.close();
    follower.close();

    const reloaded = await openTab(config);
    const hits = await new WebDerivedIndex(reloaded).search({
      limit: 10,
      query: 'rich committed run',
      threadIds: corpus.threadIds,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('rebuilds the projection from the log when the app build changes, and only then', async () => {
    const config = storeConfig('build-1');
    const first = await openTab(config);
    await storeCorpus(first);
    const firstIndex = new WebDerivedIndex(first);
    await firstIndex.catchUp();
    const before = await firstIndex.status();
    expect(before.rebuilt).toBeNull();
    first.close();

    // The same build keeps the projection it made.
    const same = await openTab(config);
    expect(await new WebDerivedIndex(same).status()).toEqual(before);
    same.close();

    // The new build's identity refuses the old projection; the writer rebuilds it from the log.
    const next = await openTab({ ...config, build: 'build-2' });
    const index = new WebDerivedIndex(next);
    const after = await index.status();
    expect(after.projection).not.toBe(before.projection);
    expect(after.rebuilt).toContain('producer schema');
    const hits = await index.search({
      limit: 10,
      query: 'canonical human interaction',
      threadIds: corpus.threadIds,
    });
    expect(hits.map((hit) => hit.role)).toContain('user');
  });

  it('refuses a tab without the app build its projection is held to, as writer or follower', async () => {
    const config = storeConfig();
    await expect(openTab({ name: config.name })).rejects.toThrow(
      'The derived index needs the app build'
    );

    // Beside a writer that has a build, the tab is refused before it would follow that writer.
    const writer = await openTab(config);
    await expect(openTab({ name: config.name })).rejects.toThrow(
      'The derived index needs the app build'
    );
    expect(await new WebDerivedIndex(writer).status()).toMatchObject({ rebuilt: null });
  });

  it('announces its extension in the wire protocol, and retires with the store', async () => {
    expect(webStateWireProtocol([DERIVED_INDEX_EXTENSION_ID])).toBe(
      `${WEB_STATE_PROTOCOL}+${DERIVED_INDEX_EXTENSION_ID}`
    );
    const config = storeConfig();
    const tab = await openTab(config);
    await storeCorpus(tab);
    await new WebDerivedIndex(tab).catchUp();
    await tab.retire();
    // The index database is closed with the rest of the pool, so factory reset can delete it.
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(webStateNames(config.name).pool, { recursive: true });
    tab.close();
    const fresh = await openTab(config);
    expect(
      await new WebDerivedIndex(fresh).search({
        limit: 10,
        query: 'rich committed run',
        threadIds: corpus.threadIds,
      })
    ).toEqual([]);
  });
});
