/**
 * BST-1932: the shipped child Memory. A read-only persona's child keeps the
 * parent's Memory options on its own thread with working memory disabled;
 * every other run keeps its options unchanged.
 */
import { expect, test } from 'vitest';
import { hostRunMemoryOptions } from '../src/production-platform.js';

const memory = {
  native: {
    options: {
      lastMessages: 12,
      observationalMemory: { enabled: true },
      workingMemory: { enabled: true, scope: 'resource' as const },
    },
  },
  recordPrompt: async () => undefined,
  resourceId: 'resource-1',
};

test('a run that withholds working memory keeps every other Memory option', () => {
  const options = hostRunMemoryOptions(memory, { workingMemory: false });
  expect(options.native.options).toEqual({
    lastMessages: 12,
    observationalMemory: { enabled: true },
    workingMemory: { enabled: false },
  });
  expect(options.resourceId).toBe('resource-1');
  expect(memory.native.options.workingMemory).toEqual({ enabled: true, scope: 'resource' });
});

test('a root or worker run keeps its Memory options unchanged', () => {
  expect(hostRunMemoryOptions(memory, {})).toBe(memory);
});
