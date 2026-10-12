import { decodeCatalogEmbeddingModel } from '@brainstrike/indexing-contract';
import { describe, expect, it } from 'vitest';
import { resolveCatalogEmbeddingPlan, unpinnedCatalogEmbeddingPlan } from '../inference-plan.js';

// The granite catalog row (migration 149) and an existing mean-pooled row, as PGlite returns them.
const GRANITE_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GRANITE_REVISION = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';
const graniteRow = {
  capabilities: { defaultDimension: 384, pooling: 'cls', type: 'embedding' },
  id: GRANITE_ID,
  parameters: {
    execution: { wasm: 'q8', webgpu: 'fp16' },
    revision: GRANITE_REVISION,
    size: '~97MB',
  },
};
const miniLmRow = {
  capabilities: { defaultDimension: 384, type: 'embedding' },
  id: 'Xenova/all-MiniLM-L6-v2',
  parameters: { size: '~23MB' },
};

describe('catalog pooling and pins (BST-1993)', () => {
  it('decodes the catalog row as the one owner of pooling, revision and execution', () => {
    expect(decodeCatalogEmbeddingModel(graniteRow)).toEqual({
      dimensions: 384,
      execution: { wasm: 'q8', webgpu: 'fp16' },
      id: GRANITE_ID,
      pooling: 'cls',
      revision: GRANITE_REVISION,
    });
    expect(decodeCatalogEmbeddingModel(miniLmRow)).toEqual({
      dimensions: 384,
      id: 'Xenova/all-MiniLM-L6-v2',
    });
    // JSON text columns decode the same way as jsonb objects.
    expect(
      decodeCatalogEmbeddingModel({
        ...graniteRow,
        capabilities: JSON.stringify(graniteRow.capabilities),
        parameters: JSON.stringify(graniteRow.parameters),
      })
    ).toEqual(decodeCatalogEmbeddingModel(graniteRow));
  });

  it.each([
    { capabilities: { ...graniteRow.capabilities, pooling: 'max' } },
    { capabilities: { ...graniteRow.capabilities, defaultDimension: 0 } },
    { parameters: { ...graniteRow.parameters, revision: 'main' } },
    { parameters: { ...graniteRow.parameters, execution: { webgpu: 'int8' } } },
  ])('refuses a malformed catalog row %#', (change) => {
    expect(() => decodeCatalogEmbeddingModel({ ...graniteRow, ...change })).toThrow();
  });

  it('requests CLS for the granite profile and keeps mean (no pooling) elsewhere', () => {
    const granite = decodeCatalogEmbeddingModel(graniteRow);
    const selection = {
      device: 'webgpu' as const,
      dimensions: 384,
      dtype: 'fp16',
      modelId: GRANITE_ID,
      revision: GRANITE_REVISION,
    };
    expect(resolveCatalogEmbeddingPlan(selection, granite)).toEqual({
      kind: 'ready',
      profile: {
        dimensions: 384,
        dtype: 'fp16',
        modelId: GRANITE_ID,
        pooling: 'cls',
        revision: GRANITE_REVISION,
      },
      workerPlan: { ...selection, pooling: 'cls' },
    });
    const miniLm = decodeCatalogEmbeddingModel(miniLmRow);
    const meanSelection = { ...selection, modelId: miniLm.id, revision: undefined };
    const { revision: _revision, ...unpinned } = meanSelection;
    const plan = resolveCatalogEmbeddingPlan(unpinned, miniLm);
    expect(plan).toEqual({
      kind: 'ready',
      profile: { dimensions: 384, dtype: 'fp16', modelId: miniLm.id },
      workerPlan: unpinned,
    });
  });

  it.each([undefined, 'a'.repeat(40)])(
    'refuses a selection whose revision %j is not the catalog pin',
    (revision) => {
      const granite = decodeCatalogEmbeddingModel(graniteRow);
      expect(
        resolveCatalogEmbeddingPlan(
          {
            device: 'webgpu',
            dimensions: 384,
            dtype: 'fp16',
            modelId: GRANITE_ID,
            ...(revision === undefined ? {} : { revision }),
          },
          granite
        )
      ).toEqual({ kind: 'unavailable', reason: expect.stringContaining('revision') });
    }
  );

  it.each([
    ['webgpu', 'fp16'],
    ['wasm', 'q8'],
  ] as const)(
    'loads granite for memory on %s with the catalog %s, pin and pooling',
    (device, dtype) => {
      const granite = decodeCatalogEmbeddingModel(graniteRow);
      expect(unpinnedCatalogEmbeddingPlan(granite, device)).toEqual({
        device,
        dimensions: 384,
        dtype,
        modelId: GRANITE_ID,
        pooling: 'cls',
        revision: GRANITE_REVISION,
      });
    }
  );
});
