import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { expect, it, vi } from 'vitest';

const { serializedCharsSpy } = vi.hoisted(() => ({
  serializedCharsSpy: vi.fn(),
}));

vi.mock('../../assistant-server/workspace-model-projection-helpers', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../assistant-server/workspace-model-projection-helpers')
    >();

  return {
    ...actual,
    serializedWorkspaceTextModelOutputChars: (lines: readonly string[]) => {
      serializedCharsSpy();
      return actual.serializedWorkspaceTextModelOutputChars(lines);
    },
  };
});

import { projectQuerySelfModelOutput } from '../../assistant-server/query-self-model-projection';

it('bounds full-projection serialization while fitting the maximum row fixture', () => {
  const wideCell = 'x'.repeat(200);
  const rows = Array.from({ length: 200 }, () => ({
    cells: [wideCell, wideCell],
  }));

  serializedCharsSpy.mockClear();
  const projection = projectQuerySelfModelOutput({
    columns: ['a', 'b'],
    estimatedCost: 42,
    kind: 'rows',
    rowCount: rows.length,
    rows,
    truncated: false,
  });

  expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
    MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
  );
  expect(serializedCharsSpy).toHaveBeenCalledTimes(9);
});
