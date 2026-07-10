import '@testing-library/jest-dom/vitest';
import type {
  CreatePromptItemInput,
  PromptItem,
  PromptItemFilter,
  PromptItemSimilarityResult,
  PromptItemUsageAction,
  UpdatePromptItemInput,
} from '@brainstrike/db';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('reconciles library rows when the connected source publishes indexing results', async () => {
    const pending = item({
      embeddingError: null,
      embeddingProfileId: null,
      embeddingRevision: null,
      embeddingStatus: 'pending',
      embeddingUpdatedAt: null,
    });
    const indexed = item({
      ...pending,
      embeddingProfileId: 'default',
      embeddingRevision: pending.revision,
      embeddingStatus: 'ready',
      embeddingUpdatedAt: new Date('2026-07-10T12:01:00Z'),
    });
    const repository = createRepository([pending]);
    const renderPanel = (initialItems: readonly PromptItem[]) => (
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={initialItems}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockResolvedValue(undefined)}
        repository={repository}
      />
    );
    const view = render(renderPanel([pending]));

    expect(screen.getByText('Indexing')).toBeInTheDocument();
    view.rerender(renderPanel([indexed]));

    expect(await screen.findByText('Indexed')).toBeInTheDocument();
    expect(screen.queryByText('Indexing')).not.toBeInTheDocument();
  });

  it('keeps a save that resolves after a newer authoritative library snapshot', async () => {
    const user = userEvent.setup();
    const original = item({ id: 'original', title: 'Original prompt' });
    const authoritative = item({ id: 'authoritative', title: 'Indexed elsewhere' });
    const created = item({ id: 'created-late', title: 'Saved after refresh' });
    let resolveCreate!: (saved: PromptItem) => void;
    const repository = createRepository([original]);
    repository.create = vi.fn(
      () =>
        new Promise<PromptItem>((resolve) => {
          resolveCreate = resolve;
        })
    );
    repository.list = vi.fn().mockResolvedValue([created, authoritative]);
    const renderPanel = (initialItems: readonly PromptItem[]) => (
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={initialItems}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockResolvedValue(undefined)}
        repository={repository}
      />
    );
    const view = render(renderPanel([original]));
    const capture = screen.getByRole('textbox', { name: 'Quick capture' });
    await user.type(capture, created.content);
    fireEvent.keyDown(capture, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(repository.create).toHaveBeenCalledTimes(1));

    view.rerender(renderPanel([authoritative]));
    expect(screen.getByText('Indexed elsewhere')).toBeInTheDocument();
    await act(async () => resolveCreate(created));

    expect(await screen.findByText('Saved after refresh')).toBeInTheDocument();
    expect(screen.getByText('Indexed elsewhere')).toBeInTheDocument();
  });

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

  it('keeps keyboard focus visible on the primary quick-capture field', () => {
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={[]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockResolvedValue(undefined)}
        repository={createRepository([])}
      />
    );

    expect(screen.getByRole('textbox', { name: 'Quick capture' })).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-ring/30'
    );
  });

  it('refreshes the saved row after indexing so status does not stay stale', async () => {
    const user = userEvent.setup();
    const pending = item({
      embeddingProfileId: null,
      embeddingRevision: null,
      embeddingStatus: 'pending',
      embeddingUpdatedAt: null,
      id: 'created-pending',
      title: 'Freshly captured thought',
    });
    const indexed = item({
      ...pending,
      embeddingProfileId: 'default',
      embeddingRevision: 1,
      embeddingStatus: 'ready',
      embeddingUpdatedAt: new Date('2026-07-10T12:01:00Z'),
    });
    const repository = createRepository([]);
    repository.create.mockResolvedValue(pending);
    repository.list = vi.fn().mockResolvedValue([indexed]);

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
    await user.type(capture, pending.content);
    fireEvent.keyDown(capture, { key: 'Enter', metaKey: true });

    expect(await screen.findByText('Indexed')).toBeInTheDocument();
    expect(repository.list).toHaveBeenCalled();
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

  it.each([
    { action: 'insert' as const, buttonName: 'Insert Evidence rule' },
    { action: 'new-thread' as const, buttonName: 'New thread from Evidence rule' },
  ])('guards an in-flight direct $action action from duplicate activation', async ({
    action,
    buttonName,
  }) => {
    const savedItem = item();
    let resolveUse!: () => void;
    const onUseItem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUse = resolve;
        })
    );
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

    const actionButton = await screen.findByRole('button', { name: buttonName });
    fireEvent.click(actionButton);
    fireEvent.click(actionButton);

    expect(onUseItem).toHaveBeenCalledTimes(1);
    expect(onUseItem).toHaveBeenCalledWith(savedItem, savedItem.content, action);
    expect(actionButton).toBeDisabled();

    await act(async () => resolveUse());
    await waitFor(() => expect(actionButton).toBeEnabled());
  });

  it('reports a refresh warning without treating an already staged prompt action as failed', async () => {
    const user = userEvent.setup();
    const savedItem = item();
    const repository = createRepository([savedItem]);
    repository.list = vi.fn().mockRejectedValue(new Error('Prompt library refresh failed.'));
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
        repository={repository}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Insert Evidence rule' }));

    expect(onUseItem).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Prompt action completed, but the library could not refresh'
    );
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

  it('keeps prepared variables open when the primary composer action fails', async () => {
    const user = userEvent.setup();
    const savedItem = item({
      content: 'Review {{target}} for {{quality}}.',
      kind: 'prompt',
      title: 'Review target',
    });
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={[savedItem]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockRejectedValue(new Error('Requested provider is unavailable.'))}
        repository={createRepository([savedItem])}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Compose Review target' }));
    const dialog = screen.getByRole('dialog', { name: 'Prepare Review target' });
    const target = within(dialog).getByRole('textbox', { name: 'target' });
    const quality = within(dialog).getByRole('textbox', { name: 'quality' });
    await user.type(target, 'the retry loop');
    await user.type(quality, 'race safety');
    await user.click(within(dialog).getByRole('button', { name: 'Add to composer' }));

    expect(
      await screen.findByRole('dialog', { name: 'Prepare Review target' })
    ).toBeInTheDocument();
    expect(target).toHaveValue('the retry loop');
    expect(quality).toHaveValue('race safety');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Requested provider is unavailable.'
    );
  });

  it('guards a templated new-thread submission while the first action is still pending', async () => {
    const user = userEvent.setup();
    const savedItem = item({
      content: 'Review {{target}} before implementation.',
      kind: 'prompt',
      title: 'Review target',
    });
    let resolveUse!: () => void;
    const pendingUse = new Promise<void>((resolve) => {
      resolveUse = resolve;
    });
    const onUseItem = vi.fn(() => pendingUse);
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

    await user.click(await screen.findByRole('button', { name: 'New thread from Review target' }));
    const dialog = screen.getByRole('dialog', { name: 'Prepare Review target' });
    await user.type(within(dialog).getByRole('textbox', { name: 'target' }), 'the retry loop');
    const form = dialog.querySelector('form');
    expect(form).not.toBeNull();

    fireEvent.submit(form as HTMLFormElement);
    fireEvent.submit(form as HTMLFormElement);

    expect(onUseItem).toHaveBeenCalledTimes(1);
    expect(onUseItem).toHaveBeenCalledWith(
      savedItem,
      'Review the retry loop before implementation.',
      'new-thread'
    );

    await act(async () => resolveUse());
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

    await user.click(within(recalled).getByRole('button', { name: 'Insert Evidence rule' }));
    expect(onUseItem).toHaveBeenCalledWith(suggestion, suggestion.content, 'insert');
  });

  it('labels a recalled runnable prompt as Compose and dispatches the compose action', async () => {
    const user = userEvent.setup();
    const suggestion = item({
      id: 'suggested-prompt',
      kind: 'prompt',
      title: 'Adversarial review',
    });
    const onRequestSuggestions = vi
      .fn<(context: string) => Promise<PromptItemSimilarityResult[]>>()
      .mockResolvedValue([{ ...suggestion, similarity: 0.91 }]);
    const onUseItem = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext="Review this change adversarially."
        initialItems={[]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={onRequestSuggestions}
        onUseItem={onUseItem}
        repository={createRepository([])}
      />
    );

    const recalled = await screen.findByTestId('prompt-context-suggestion-suggested-prompt');
    const composeButton = within(recalled).getByRole('button', {
      name: 'Compose Adversarial review',
    });
    expect(composeButton).toHaveTextContent('Compose');

    await user.click(composeButton);
    expect(onUseItem).toHaveBeenCalledWith(suggestion, suggestion.content, 'compose');
  });

  it('does not run contextual recall while the owning sidebar tab is inactive', async () => {
    const onRequestSuggestions = vi.fn().mockResolvedValue([]);
    const repository = createRepository([]);
    const renderPanel = (suggestionsEnabled: boolean) => (
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext="Review this live draft."
        initialItems={[]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={onRequestSuggestions}
        onUseItem={vi.fn().mockResolvedValue(undefined)}
        repository={repository}
        suggestionsEnabled={suggestionsEnabled}
      />
    );
    const view = render(renderPanel(false));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onRequestSuggestions).not.toHaveBeenCalled();

    view.rerender(renderPanel(true));
    await waitFor(() =>
      expect(onRequestSuggestions).toHaveBeenCalledWith('Review this live draft.')
    );
  });

  it('edits thoughtful prompt fields with optimistic revision ownership', async () => {
    const user = userEvent.setup();
    const modelSettings = { maxOutputTokens: 2048, temperature: 0.25 };
    const savedItem = item({
      modelKey: 'openai::gpt-5.2',
      modelSettings,
      rating: 4,
    });
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
          modelSettings,
          rating: 4,
        })
      )
    );
  });

  it('shows and preserves an unavailable stored model during an unrelated edit', async () => {
    const user = userEvent.setup();
    const modelSettings = { maxOutputTokens: 2048, temperature: 0.25 };
    const savedItem = item({
      modelKey: 'openai::retired-model',
      modelSettings,
      rating: 4,
    });
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
    const modelSelect = within(dialog).getByRole<HTMLSelectElement>('combobox', {
      name: 'Run with',
    });
    expect(modelSelect).toHaveValue('openai::retired-model');
    expect(
      within(modelSelect).getByRole('option', { name: 'Unavailable · openai::retired-model' })
    ).toBeDisabled();

    const intention = within(dialog).getByRole('textbox', { name: 'Intention' });
    await user.clear(intention);
    await user.type(intention, 'Preserve the configured runtime while clarifying intent');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(repository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Preserve the configured runtime while clarifying intent',
          modelKey: 'openai::retired-model',
          modelSettings,
          rating: 4,
        })
      )
    );
  });

  it('announces builder save failures inside the open dialog', async () => {
    const user = userEvent.setup();
    const repository = createRepository([]);
    repository.create.mockRejectedValueOnce(new Error('Prompt save failed.'));
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

    await user.click(screen.getByRole('button', { name: 'Build a prompt' }));
    const dialog = screen.getByRole('dialog', { name: 'Build a prompt' });
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Prompt text' }),
      'Audit the failure path before claiming success.'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save prompt' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Prompt save failed.');
    expect(dialog).toBeInTheDocument();
  });

  it('closes the builder after creating a prompt even when indexing fails', async () => {
    const user = userEvent.setup();
    const repository = createRepository([]);
    const onLibraryChanged = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Prompt indexing is unavailable.'));
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={[]}
        modelOptions={[]}
        onLibraryChanged={onLibraryChanged}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockResolvedValue(undefined)}
        repository={repository}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Build a prompt' }));
    const dialog = screen.getByRole('dialog', { name: 'Build a prompt' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Failure audit');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Prompt text' }),
      'Audit the failure path before claiming success.'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save prompt' }));

    await waitFor(() => expect(repository.create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Build a prompt' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Prompt indexing is unavailable.');
    expect(repository.list).toHaveBeenCalled();
  });

  it('closes the builder after creating a prompt even when the saved library cannot refresh', async () => {
    const user = userEvent.setup();
    const repository = createRepository([]);
    repository.list = vi.fn().mockRejectedValue(new Error('Prompt library refresh failed.'));
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

    await user.click(screen.getByRole('button', { name: 'Build a prompt' }));
    const dialog = screen.getByRole('dialog', { name: 'Build a prompt' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Failure audit');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Prompt text' }),
      'Audit the failure path before claiming success.'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save prompt' }));

    await waitFor(() => expect(repository.create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Build a prompt' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Prompt library refresh failed.');
  });

  it('closes the builder after editing a prompt when indexing fails and clears the warning after a later successful edit', async () => {
    const user = userEvent.setup();
    const savedItem = item();
    const repository = createRepository([savedItem]);
    const onLibraryChanged = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Prompt indexing is unavailable.'))
      .mockResolvedValueOnce(undefined);
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={[savedItem]}
        modelOptions={[]}
        onLibraryChanged={onLibraryChanged}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockResolvedValue(undefined)}
        repository={repository}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Edit Evidence rule' }));
    let dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(repository.update).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit Evidence rule' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Prompt indexing is unavailable.');
    expect(repository.list).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Edit Evidence rule' }));
    dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(repository.update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(repository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 2, id: savedItem.id })
    );
  });

  it('clears a stale action error when a later builder save succeeds', async () => {
    const user = userEvent.setup();
    const savedItem = item();
    const repository = createRepository([savedItem]);
    render(
      <PromptWorkbenchPanel
        activeThreadId="thread-active"
        composerContext=""
        initialItems={[savedItem]}
        modelOptions={[]}
        onLibraryChanged={vi.fn().mockResolvedValue(undefined)}
        onRequestSuggestions={vi.fn().mockResolvedValue([])}
        onUseItem={vi.fn().mockRejectedValue(new Error('Provider is unavailable.'))}
        repository={repository}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Insert Evidence rule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider is unavailable.');

    await user.click(screen.getByRole('button', { name: 'Edit Evidence rule' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
