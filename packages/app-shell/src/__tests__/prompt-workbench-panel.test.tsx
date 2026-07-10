import '@testing-library/jest-dom/vitest';
import type {
  CreatePromptItemInput,
  PromptItem,
  PromptItemFilter,
  PromptItemSimilarityResult,
  PromptItemUsageAction,
  UpdatePromptItemInput,
} from '@brainstrike/db';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PromptWorkbenchPanel, type PromptWorkbenchRepository } from '../prompt-workbench-panel';

function item(overrides: Partial<PromptItem> = {}): PromptItem {
  return {
    archivedAt: null,
    content: 'Always cite the exact file and line.',
    createdAt: new Date('2026-07-10T12:00:00Z'),
    description: 'Evidence discipline',
    embeddingError: null,
    embeddingProfileId: 'default',
    embeddingRevision: 1,
    embeddingStatus: 'ready',
    embeddingUpdatedAt: new Date('2026-07-10T12:00:00Z'),
    id: 'item-1',
    isFavorite: false,
    kind: 'snippet',
    lastUsedAction: null,
    lastUsedAt: null,
    modelKey: null,
    modelSettings: null,
    rating: null,
    revision: 1,
    sourceUrl: null,
    tags: ['evidence'],
    title: 'Evidence rule',
    updatedAt: new Date('2026-07-10T12:00:00Z'),
    useCount: 0,
    ...overrides,
  };
}

function createRepository(initialItems: PromptItem[]): PromptWorkbenchRepository & {
  create: ReturnType<typeof vi.fn<(input: CreatePromptItemInput) => Promise<PromptItem>>>;
  update: ReturnType<typeof vi.fn<(input: UpdatePromptItemInput) => Promise<PromptItem>>>;
} {
  let items = [...initialItems];
  return {
    create: vi.fn(async (input) => {
      const created = item({
        content: input.content,
        id: `created-${items.length + 1}`,
        kind: input.kind ?? 'fragment',
        title: input.title ?? input.content,
      });
      items = [created, ...items];
      return created;
    }),
    list: vi.fn(async (_filter?: PromptItemFilter) => [...items]),
    recordUsage: vi.fn(async (id: string, action: PromptItemUsageAction) => {
      const found = items.find((candidate) => candidate.id === id);
      if (!found) {
        throw new Error(`Missing item ${id}`);
      }
      return { ...found, lastUsedAction: action, useCount: found.useCount + 1 };
    }),
    update: vi.fn(async (input) => {
      const current = items.find((candidate) => candidate.id === input.id);
      if (!current) {
        throw new Error(`Missing item ${input.id}`);
      }
      const updated = { ...current, ...input, revision: current.revision + 1 };
      items = items.map((candidate) => (candidate.id === input.id ? updated : candidate));
      return updated;
    }),
  };
}

describe('PromptWorkbenchPanel', () => {
  it('captures an unstructured text clip as a fragment with one shortcut', async () => {
    const user = userEvent.setup();
    const repository = createRepository([]);
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={[]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockResolvedValue(undefined)}
        repository={repository}
      />
    );

    const capture = screen.getByRole('textbox', { name: 'Quick capture' });
    await user.type(capture, 'Compare the failure path with the success path.');
    fireEvent.keyDown(capture, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(repository.create).toHaveBeenCalledWith({
        content: 'Compare the failure path with the success path.',
        kind: 'fragment',
      });
    });
    expect(capture).toHaveValue('');
    expect(screen.getByText('Compare the failure path with the success path.')).toBeInTheDocument();
  });

  it('inserts a reusable snippet into the active composer without auto-running it', async () => {
    const user = userEvent.setup();
    const savedItem = item();
    const onUseItem = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext="Working draft"
        initialItems={[savedItem]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={onUseItem}
        repository={createRepository([savedItem])}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Insert Evidence rule' }));

    expect(onUseItem).toHaveBeenCalledWith(savedItem, savedItem.content, 'insert');
  });

  it('resolves prompt variables explicitly before composing a full prompt', async () => {
    const user = userEvent.setup();
    const savedItem = item({
      content: 'Review {{target}} for {{quality}}. Re-check {{target}}.',
      kind: 'prompt',
      title: 'Review target',
    });
    const onUseItem = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={[savedItem]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={onUseItem}
        repository={createRepository([savedItem])}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Compose Review target' }));
    const dialog = screen.getByRole('dialog', { name: 'Prepare Review target' });
    await user.type(within(dialog).getByRole('textbox', { name: 'target' }), 'the retry loop');
    await user.type(within(dialog).getByRole('textbox', { name: 'quality' }), 'race safety');
    await user.click(within(dialog).getByRole('button', { name: 'Add to composer' }));

    expect(onUseItem).toHaveBeenCalledWith(
      savedItem,
      'Review the retry loop for race safety. Re-check the retry loop.',
      'compose'
    );
  });

  it('automatically recalls contextual suggestions and keeps insertion explicit', async () => {
    const user = userEvent.setup();
    const suggestion = item({ id: 'suggested' });
    const onRequestSuggestions = vi
      .fn<(context: string) => Promise<PromptItemSimilarityResult[]>>()
      .mockResolvedValue([{ ...suggestion, similarity: 0.87 }]);
    const onUseItem = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext="I need exact evidence for this code review."
        initialItems={[]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={onRequestSuggestions}
        onUseItem={onUseItem}
        repository={createRepository([])}
      />
    );

    await waitFor(() =>
      expect(onRequestSuggestions).toHaveBeenCalledWith(
        'I need exact evidence for this code review.'
      )
    );
    const recalled = await screen.findByTestId('prompt-context-suggestion-suggested');
    expect(recalled).toHaveTextContent('87% match');
    expect(onUseItem).not.toHaveBeenCalled();

    await user.click(within(recalled).getByRole('button', { name: 'Insert suggestion' }));
    expect(onUseItem).toHaveBeenCalledWith(suggestion, suggestion.content, 'insert');
  });

  it('edits thoughtful prompt fields with optimistic revision ownership', async () => {
    const user = userEvent.setup();
    const savedItem = item();
    const repository = createRepository([savedItem]);
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={[savedItem]}
        modelOptions={[{ key: 'openai::gpt-5.4', label: 'OpenAI · GPT-5.4' }]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockResolvedValue(undefined)}
        repository={repository}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Edit Evidence rule' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    const intention = within(dialog).getByRole('textbox', { name: 'Intention' });
    await user.clear(intention);
    await user.type(intention, 'Demand traceable claims');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Run with' }), [
      'openai::gpt-5.4',
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(repository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Demand traceable claims',
          expectedRevision: 1,
          id: 'item-1',
          modelKey: 'openai::gpt-5.4',
        })
      )
    );
  });
});
