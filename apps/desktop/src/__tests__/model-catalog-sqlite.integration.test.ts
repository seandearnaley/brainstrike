// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';

const forbiddenPg = vi.hoisted(() =>
  vi.fn(async (): Promise<never> => {
    throw new Error('Desktop PG unavailable');
  })
);
vi.mock('../db-main', () => ({ getDatabase: forbiddenPg }));

import { productionDesktopCapabilities } from '../agent-host-platform/production-desktop-capabilities';
import { createCatalogRetrievalStore } from '../assistant-server/retrieval-store-catalog';
import { createDesktopModelCatalog } from '../model-catalog';

test('Main catalog toggles and Undo use the sole writer and survive full store reopen', async () => {
  const path = await mkdtemp(join(tmpdir(), 'desktop-model-choice-'));
  let store = await StateStore.open(path);
  try {
    const catalog = createDesktopModelCatalog(store);
    const admission = productionDesktopCapabilities({
      modelCatalog: catalog,
      retrievalStore: createCatalogRetrievalStore(store),
      workspaceRoots: store,
    }).admission;
    const before = await catalog.read();
    const first = before.models.find((model) => model.providerId === 'openai');
    if (!first) {
      throw new Error('OpenAI model missing from real catalog.');
    }
    expect(
      await admission.catalogModel(
        { model: first.id, provider: 'openai' },
        new AbortController().signal
      )
    ).toEqual({
      isEnabled: first.isEnabled,
      providerId: 'openai',
    });
    const changed = await catalog.setModels([first.id], !first.isEnabled);
    expect(changed.previous).toEqual([{ enabled: first.isEnabled, modelId: first.id }]);
    await expect(
      catalog.setModels([first.id, 'not-a-real-model'], first.isEnabled)
    ).rejects.toThrow();
    expect(await catalog.read()).toEqual(changed.snapshot);
    expect(
      await admission.catalogModel(
        { model: first.id, provider: 'openai' },
        new AbortController().signal
      )
    ).toEqual({
      isEnabled: !first.isEnabled,
      providerId: 'openai',
    });
    expect(forbiddenPg).not.toHaveBeenCalled();
    await store.close();
    store = await StateStore.open(path);
    const reopened = createDesktopModelCatalog(store);
    expect(await reopened.read()).toEqual(changed.snapshot);
    expect((await reopened.setModels([first.id], first.isEnabled)).snapshot).toEqual(before);
    await expect(reopened.setProvider('not-a-provider', true)).rejects.toThrow();
  } finally {
    await store.close();
    await rm(path, { force: true, recursive: true });
  }
});
