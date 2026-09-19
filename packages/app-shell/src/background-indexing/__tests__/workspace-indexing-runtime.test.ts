import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import {
  createWorkspaceIndexingQosResolver,
  createWorkspaceIndexingRepositories,
} from '../workspace-indexing-runtime';

describe('workspace indexing runtime construction', () => {
  it('rejects a database handle that cannot support repository writes', () => {
    const db = {
      query: async () => ({ rows: [] }),
    } as unknown as DbHandle;

    expect(() => createWorkspaceIndexingRepositories(db)).toThrow(
      'Background indexing requires database exec support.'
    );
  });

  it('rejects QoS resolution without scheduler pressure readers', async () => {
    const resolveQosPolicy = createWorkspaceIndexingQosResolver({
      readBackgroundIndexingPaused: () => false,
      readDatabasePressure: null,
      readForegroundQueryActive: () => false,
      readPipelineInputs: null,
      readPowerSnapshot: null,
      readRecentUserInputMs: () => null,
      readWindowVisible: () => true,
    });

    await expect(resolveQosPolicy()).rejects.toThrow(
      'Workspace Index QoS requires database scheduler snapshots.'
    );
  });
});
