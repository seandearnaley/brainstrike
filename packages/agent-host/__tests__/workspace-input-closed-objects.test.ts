import { NATIVE_TOOLS } from '@brainstrike/assistant-contract';
import { validateToolInputValue } from '@brainstrike/assistant-contract/native-tool-schemas';
import { expect, test } from 'vitest';

test.each([
  { id: 'brainstrike.manageCanvas', input: { action: 'list', unknown: 1 } },
  { id: 'brainstrike.listWorkspaceContext', input: { unknown: 1 } },
])('$id rejects an excess key and names it', ({ id, input }) => {
  const tool = NATIVE_TOOLS.find((entry) => entry.id === id);
  if (!tool) {
    throw new Error(`Missing native tool: ${id}`);
  }
  const result = validateToolInputValue(tool.inputSchema, input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.issues.map((issue) => issue.path)).toEqual([['unknown']]);
  }
});
