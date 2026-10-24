import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from 'playwright';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { updateIndexConfig } from './utils/index-config';

// BST-2005: switching from one WebGPU embedding model to another in the same session left the
// embedding host with a destroyed WebGPU device ("WebGPU device lost: Device was destroyed."),
// and the second model never indexed or answered a query.
const DOCUMENTS = {
  'garden.md': '# Garden notes\nTomatoes want six hours of direct sun and deep, steady watering.\n',
  'release.md':
    '# Shipping\nBefore a build goes out, notarize it, upload the installer to the update server and announce the version.\n',
} as const;
const MODELS = ['Xenova/bge-small-en-v1.5', 'Xenova/all-MiniLM-L6-v2'] as const;

type Bridges = typeof globalThis & {
  readonly embeddingHost?: VisibleEmbeddingHostBridge;
  readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
};

/** Semantic search with the model on WebGPU · FP16, saved through Main as Settings saves it. */
async function chooseWebGpuModel(page: Page, modelId: string): Promise<void> {
  await updateIndexConfig(page, {
    mode: 'semantic',
    model: {
      dimensions: 384,
      local: { device: 'webgpu', dtype: 'fp16' },
      modelKey: `local::${modelId}`,
    },
  });
}

async function vectorsComplete(page: Page): Promise<boolean> {
  return await page.evaluate(async (files) => {
    const capability = (globalThis as Bridges).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('Native capability missing');
    }
    const status = await capability.status();
    if (status.kind !== 'ready') {
      return false;
    }
    const observation = await capability.coverageBatch([{ rootIds: status.authorizedRootIds }]);
    if (observation.kind === 'invalidated') {
      return false;
    }
    if (observation.kind === 'blocked') {
      throw new Error(observation.reason);
    }
    const totals = observation.coverage[0]?.totals;
    return (
      observation.status.rootReadiness.every((root) => root.scanComplete) &&
      totals?.indexedFiles === files &&
      totals.chunks > 0 &&
      totals.vectors === totals.chunks &&
      totals.missingVectors === 0
    );
  }, Object.keys(DOCUMENTS).length);
}

async function semanticSearch(page: Page): Promise<{
  readonly device: string | undefined;
  readonly modelKey: string;
  readonly top: string | null | undefined;
}> {
  return await page.evaluate(async () => {
    const { embeddingHost, __brainstrikeTestHooks__ } = globalThis as Bridges;
    const indexSearch = __brainstrikeTestHooks__?.indexSearch;
    if (!(indexSearch && embeddingHost && 'queryEmbedding' in embeddingHost)) {
      throw new Error('Native search/query bridge unavailable');
    }
    const status = await indexSearch.status();
    if (
      status.kind !== 'ready' ||
      status.embedding.indexMode !== 'vector-configured' ||
      !status.queryPlan
    ) {
      throw new Error('Selected collection has no ready semantic query plan');
    }
    const response = await embeddingHost.queryEmbedding({
      dimensions: status.embedding.profile.dimensions,
      modelId: status.embedding.profile.modelId,
      modelKey: status.queryPlan.modelKey,
      query: 'how do we publish a new version of the app',
      ...(status.queryPlan.inferencePlan ? { inferencePlan: status.queryPlan.inferencePlan } : {}),
    });
    if (!response.ok) {
      throw new Error(JSON.stringify(response.error));
    }
    const vector = response.value;
    const result = await indexSearch.search({
      limit: 2,
      mode: 'vector',
      profile: status.embedding.profile,
      rootIds: status.authorizedRootIds,
      vector,
    });
    return {
      device: status.queryPlan.inferencePlan?.device,
      modelKey: status.queryPlan.modelKey,
      top: result.hits[0]?.relativePath,
    };
  });
}

test.describe('WebGPU embedding model switch (desktop)', () => {
  test('indexes and searches with a second WebGPU model after switching in the same session', async ({
    electron,
  }) => {
    test.setTimeout(600_000);
    const previousAllowGpu = process.env['BRAINSTRIKE_E2E_ALLOW_GPU'];
    process.env['BRAINSTRIKE_E2E_ALLOW_GPU'] = '1';
    const folder = await mkdtemp(join(tmpdir(), 'brainstrike-webgpu-switch-'));
    for (const [name, content] of Object.entries(DOCUMENTS)) {
      await writeFile(join(folder, name), content);
    }
    try {
      const { app, window } = await electron.ensureContext();
      // The embedding host's own detection decides; a host without an adapter cannot run this.
      const adapter = await window.evaluate(async () => {
        const bridge = (globalThis as Bridges).embeddingHost;
        if (!bridge?.webgpuAdapter) {
          throw new Error('The embedding host WebGPU detection bridge is unavailable.');
        }
        return await bridge.webgpuAdapter();
      });
      test.skip(!adapter.available, `This host has no WebGPU adapter: ${adapter.reason}`);

      await app.evaluate((_electron, path) => {
        process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = path;
      }, folder);
      await ensureFileExplorerPanelVisible(window);
      await window.getByTestId('select-root-button').click();
      await expect(
        window.getByRole('treegrid', { name: 'File tree' }).getByText('release.md')
      ).toBeVisible({ timeout: 15_000 });

      for (const modelId of MODELS) {
        await chooseWebGpuModel(window, modelId);
        // Includes each model's first download into the fresh profile.
        await expect
          .poll(async () => await vectorsComplete(window), { timeout: 240_000 })
          .toBe(true);
        expect(await semanticSearch(window)).toEqual({
          device: 'webgpu',
          modelKey: `local::${modelId}`,
          top: 'release.md',
        });
      }
    } finally {
      await electron.dispose();
      await rm(folder, { force: true, recursive: true });
      if (previousAllowGpu === undefined) {
        delete process.env['BRAINSTRIKE_E2E_ALLOW_GPU'];
      } else {
        process.env['BRAINSTRIKE_E2E_ALLOW_GPU'] = previousAllowGpu;
      }
    }
  });
});
