import { describe, expect, it, vi } from 'vitest';
import {
  importLegacyPromptStore,
  LEGACY_PROMPT_STORE_KEY,
  parseLegacyPromptStore,
} from '../prompt-library-legacy-import';

const legacyState = {
  state: {
    categories: [{ color: '#0ea5e9', icon: 'Code', id: 'research', name: 'Research' }],
    prompts: [
      {
        categoryId: 'research',
        content: 'Compare the alternatives and cite evidence.',
        createdAt: Date.parse('2025-01-01T10:00:00.000Z'),
        id: 'legacy-prompt',
        isFavorite: true,
        modelSettings: {
          maxTokens: 1200,
          model: 'gpt-4.1',
          temperature: 0.3,
          topP: 0.9,
        },
        rating: 5,
        revisions: [
          {
            content: 'Compare the alternatives.',
            id: 'legacy-revision',
            note: 'Before evidence requirement',
            timestamp: Date.parse('2024-12-31T10:00:00.000Z'),
          },
        ],
        site: 'https://example.com/research',
        tags: ['Analysis'],
        title: 'Research comparison',
        updatedAt: Date.parse('2025-01-02T10:00:00.000Z'),
      },
    ],
  },
  version: 0,
};

describe('legacy prompt library import', () => {
  it('strictly maps the old Zustand payload into first-class prompt records', () => {
    expect(parseLegacyPromptStore(JSON.stringify(legacyState))).toEqual({
      items: [
        expect.objectContaining({
          content: 'Compare the alternatives and cite evidence.',
          id: 'legacy-prompt',
          isFavorite: true,
          kind: 'prompt',
          modelKey: null,
          rating: 5,
          sourceUrl: 'https://example.com/research',
          tags: ['analysis', 'research'],
          title: 'Research comparison',
        }),
      ],
    });
    const item = parseLegacyPromptStore(JSON.stringify(legacyState)).items[0];
    expect(item?.createdAt.toISOString()).toBe('2025-01-01T10:00:00.000Z');
    expect(item?.revisions[0]).toMatchObject({
      content: 'Compare the alternatives.',
      id: 'legacy-revision',
      note: 'Before evidence requirement',
    });
  });

  it('removes legacy storage only after the database transaction succeeds', async () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify(legacyState)),
      removeItem: vi.fn(),
    };
    const repository = { importSnapshot: vi.fn().mockResolvedValue(undefined) };

    await expect(importLegacyPromptStore(repository, storage)).resolves.toEqual({ imported: 1 });
    expect(repository.importSnapshot).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).toHaveBeenCalledWith(LEGACY_PROMPT_STORE_KEY);
    expect(repository.importSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      storage.removeItem.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('retains the legacy payload when parsing or persistence fails', async () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify(legacyState)),
      removeItem: vi.fn(),
    };
    const repository = {
      importSnapshot: vi.fn().mockRejectedValue(new Error('transaction rolled back')),
    };

    await expect(importLegacyPromptStore(repository, storage)).rejects.toThrow(
      'transaction rolled back'
    );
    expect(storage.removeItem).not.toHaveBeenCalled();

    storage.getItem.mockReturnValue('{invalid json');
    await expect(importLegacyPromptStore(repository, storage)).rejects.toThrow(
      /legacy prompt store is not valid JSON/i
    );
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
