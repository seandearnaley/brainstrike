import type { IDatabase } from '@brainstrike/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { getModelConfigFromDb, invalidateModelConfigCache } from '../embedding-model-config.js';

const GRANITE_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
function database(capabilities: unknown): IDatabase {
  return {
    query: async () => ({
      rows: [
        {
          capabilities,
          description: null,
          id: GRANITE_ID,
          name: 'Granite',
          parameters: { size: '~97MB' },
          provider_id: 'local',
        },
      ],
    }),
  } as unknown as IDatabase;
}

describe('legacy catalog model config pooling (BST-1993)', () => {
  beforeEach(() => {
    invalidateModelConfigCache();
  });

  it('carries the catalog row pooling, so a legacy load never embeds granite with mean', async () => {
    await expect(
      getModelConfigFromDb(
        database({ defaultDimension: 384, pooling: 'cls', type: 'embedding' }),
        GRANITE_ID
      )
    ).resolves.toMatchObject({ dimensions: 384, pooling: 'cls' });
  });

  it('leaves pooling absent for rows that state none', async () => {
    const config = await getModelConfigFromDb(
      database(JSON.stringify({ defaultDimension: 384, type: 'embedding' })),
      GRANITE_ID
    );
    expect(config).not.toHaveProperty('pooling');
  });

  it('refuses an unknown pooling instead of loading the model with mean', async () => {
    await expect(
      getModelConfigFromDb(
        database({ defaultDimension: 384, pooling: 'max', type: 'embedding' }),
        GRANITE_ID
      )
    ).rejects.toThrow('pooling');
  });
});
