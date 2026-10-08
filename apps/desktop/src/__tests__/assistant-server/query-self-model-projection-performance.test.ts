import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { expect, it, vi } from 'vitest';

const { decodedCharsSpy } = vi.hoisted(() => ({
  decodedCharsSpy: vi.fn(),
}));

vi.mock(
  '../../../../../packages/host-capabilities/src/native-tools/workspace-model-projection-helpers',
  async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@brainstrike/host-capabilities/native-tools')>();

    return {
      ...actual,
      decodedWorkspaceTextModelOutputChars: (lines: readonly string[]) => {
        decodedCharsSpy();
        return actual.decodedWorkspaceTextModelOutputChars(lines);
      },
    };
  }
);

import { projectQuerySelfModelOutput } from '../../assistant-server/query-self-model-projection';

it('bounds full-projection serialization while fitting the maximum row fixture', () => {
  const wideCell = 'x'.repeat(200);
  const rows = Array.from({ length: 200 }, () => ({
    cells: [wideCell, wideCell],
  }));

  decodedCharsSpy.mockClear();
  const projection = projectQuerySelfModelOutput({
    columns: ['a', 'b'],
    estimatedCost: 42,
    kind: 'rows',
    rowCount: rows.length,
    rows,
    target: 'app',
    truncated: false,
  });

  expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
    MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
  );
  // Linear decrement-and-reserialize needed 188 full serializations on this
  // fixture. Largest-prefix search stays logarithmic; the bound avoids coupling
  // the test to incidental header widths or the final fit assertion.
  expect(decodedCharsSpy.mock.calls.length).toBeLessThanOrEqual(12);
});
