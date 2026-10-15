// @vitest-environment node
import { createLogger } from '@brainstrike/logging';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reportUnidentifiedRow,
  resetReportedUnidentifiedRowsForTests,
} from '../tree/file-tree-metadata-diagnostics';

describe('file-tree metadata diagnostic ledger', () => {
  beforeEach(() => {
    resetReportedUnidentifiedRowsForTests();
  });

  it('evicts the oldest row at the bound while retaining once-per-row logging', () => {
    const error = vi
      .spyOn(createLogger('FileTreeMetadataCells'), 'error')
      .mockImplementation(() => undefined);

    for (let index = 0; index <= 100; index += 1) {
      reportUnidentifiedRow(`/row-${index}.ts`);
    }
    expect(error).toHaveBeenCalledTimes(101);

    // row-0 was the oldest and is admitted again after eviction. The newest
    // row remains in the ledger and is still logged only once.
    reportUnidentifiedRow('/row-0.ts');
    reportUnidentifiedRow('/row-100.ts');
    expect(error).toHaveBeenCalledTimes(102);
  });
});
