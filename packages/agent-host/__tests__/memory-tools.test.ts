import { HOST_META_TOOL_ID } from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import { hostMemoryTools } from '../src/adapters/memory-tools.js';

// The renderer names the working-memory tool by the contract's id; Mastra
// Memory owns the wire name. A vendor rename must fail here, not read as a raw
// "Used updateWorkingMemory" row.
test('the host declares Memory’s working-memory tool under the contract’s id', () => {
  const tools = hostMemoryTools(
    { options: { workingMemory: { enabled: true, scope: 'thread' } } },
    () => Promise.reject(new Error('This proof calls no Memory tool'))
  );
  expect(Object.keys(tools)).toContain(HOST_META_TOOL_ID.updateWorkingMemory);
});
