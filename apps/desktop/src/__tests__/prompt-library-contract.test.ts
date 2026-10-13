import { expect, test } from 'vitest';
import { parsePromptLibraryRequest } from '../ipc-domains/prompt-library-args';

test('prompt request boundary preserves supported metadata and rejects malformed mutation/inference fields', () => {
  expect(
    parsePromptLibraryRequest({
      input: {
        content: 'Review {{path}}',
        id: 'prompt-item-original',
        kind: 'prompt',
        modelKey: 'openai::gpt-5.2',
        modelSettings: { temperature: 0.2 },
      },
      operation: 'create',
    })
  ).toMatchObject({
    input: {
      content: 'Review {{path}}',
      id: 'prompt-item-original',
      kind: 'prompt',
      modelSettings: { temperature: 0.2 },
    },
    operation: 'create',
  });
  for (const request of [
    { id: '  ', operation: 'delete' },
    {
      input: {
        content: 'changed',
        expectedRevision: 0,
        id: 'prompt-item-original',
        isFavorite: false,
        kind: 'prompt',
        tags: [],
      },
      operation: 'update',
    },
    {
      input: { embedding: [1], itemId: 'prompt-item-original', revision: 1 },
      operation: 'store-embedding',
    },
    {
      operation: 'similar',
      options: { threshold: 2 },
      vector: Array.from({ length: 384 }, () => 0),
    },
    { filter: { includeArchived: 'true' }, operation: 'list' },
    { action: 'execute', id: 'prompt-item-original', operation: 'usage' },
    { id: 'prompt-item-original', operation: 'delete', sql: 'DROP TABLE prompt_items' },
  ]) {
    expect(() => parsePromptLibraryRequest(request)).toThrow();
  }
});
