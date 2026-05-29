import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptEditorSaveData } from '../components/prompt-editor';
import { PromptManager } from '../prompt-manager';
import type { Category, Prompt, PromptFilter } from '../types';

const mocks = vi.hoisted(() => {
  const prompts: Prompt[] = [
    {
      id: 'prompt-1',
      title: 'Existing prompt',
      content: 'Existing prompt content',
      categoryId: 'general',
      tags: ['existing'],
      modelSettings: {
        model: 'openai:gpt-4o-mini',
        temperature: 0.4,
        topP: 0.8,
        maxTokens: 2048,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
      },
      revisions: [],
      rating: 3,
      isFavorite: false,
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  const categories: Category[] = [
    { id: 'general', name: 'General', color: '#64748b', icon: 'Box' },
  ];
  const filter: PromptFilter = { search: '', tags: [], favoritesOnly: false };

  return {
    store: {
      prompts,
      categories,
      filter,
      setFilter: vi.fn(),
      addPrompt: vi.fn(),
      addRevision: vi.fn(),
      updatePrompt: vi.fn(),
      deletePrompt: vi.fn(),
      toggleFavorite: vi.fn(),
    },
    toast: vi.fn(),
    clipboardWriteText: vi.fn(),
  };
});

vi.mock('../store', () => ({
  usePromptStore: () => mocks.store,
}));

vi.mock('../../use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../components/sidebar', () => ({
  Sidebar: ({
    onAddPrompt,
    onFilterChange,
  }: {
    onAddPrompt: () => void;
    onFilterChange: (filter: Partial<PromptFilter>) => void;
  }) => (
    <div>
      <button onClick={onAddPrompt} type="button">
        mock-add-prompt
      </button>
      <button onClick={() => onFilterChange({ search: 'updated-search' })} type="button">
        mock-filter
      </button>
    </div>
  ),
}));

vi.mock('../components/prompt-list', () => ({
  PromptList: ({
    onEdit,
    onDelete,
    onCopy,
    onToggleFavorite,
  }: {
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
    onCopy: (content: string) => void;
    onToggleFavorite: (id: string) => void;
  }) => (
    <div>
      <button onClick={() => onEdit('prompt-1')} type="button">
        mock-edit
      </button>
      <button onClick={() => onDelete('prompt-1')} type="button">
        mock-delete
      </button>
      <button onClick={() => onCopy('copied content')} type="button">
        mock-copy
      </button>
      <button onClick={() => onToggleFavorite('prompt-1')} type="button">
        mock-favorite
      </button>
    </div>
  ),
}));

vi.mock('../components/prompt-editor', () => ({
  PromptEditor: ({
    isOpen,
    onClose,
    onSave,
    prompt,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onSave: (data: PromptEditorSaveData) => void;
    prompt: Prompt | null;
  }) =>
    isOpen ? (
      <div>
        <div>{prompt ? `editing-${prompt.id}` : 'creating-new'}</div>
        <button onClick={() => onSave({ title: 'missing-required-fields' })} type="button">
          mock-save-invalid
        </button>
        <button
          onClick={() =>
            onSave({
              title: 'Created prompt',
              content: 'Created content',
              categoryId: 'general',
              tags: ['new'],
              modelSettings: { model: 'openai:gpt-4o-mini', temperature: 0.5, topP: 1 },
              site: 'https://example.com',
            })
          }
          type="button"
        >
          mock-save-create
        </button>
        <button onClick={() => onSave({ title: 'Edited prompt title' })} type="button">
          mock-save-edit
        </button>
        <button
          onClick={() =>
            onSave({
              title: 'Edited prompt title',
              modelSettings: {
                model: 'openai:gpt-4o-mini',
                temperature: 0.4,
                topP: 0.8,
                maxTokens: 2048,
                frequencyPenalty: 0.1,
                presencePenalty: 0.2,
              },
            })
          }
          type="button"
        >
          mock-save-same-full-settings
        </button>
        <button
          onClick={() =>
            onSave({
              modelSettings: {
                model: 'openai:gpt-4o-mini',
                temperature: 0.4,
                topP: 0.8,
                maxTokens: 2048,
                frequencyPenalty: 0.1,
                presencePenalty: 0.9,
              },
            })
          }
          type="button"
        >
          mock-save-presence-edit
        </button>
        <button
          onClick={() =>
            onSave({
              content: 'Edited prompt content',
              modelSettings: { model: 'openai:gpt-4.1-mini', temperature: 0.7, topP: 1 },
            })
          }
          type="button"
        >
          mock-save-content-edit
        </button>
        <button
          onClick={() =>
            onSave({
              content: 'Restored prompt content',
              modelSettings: { model: 'openai:gpt-4.1-mini', temperature: 0.7, topP: 1 },
              revisionNote: 'Before restore',
            })
          }
          type="button"
        >
          mock-save-restored-content
        </button>
        <button onClick={onClose} type="button">
          mock-close-editor
        </button>
      </div>
    ) : null,
}));

describe('PromptManager', () => {
  beforeEach(() => {
    mocks.store.setFilter.mockReset();
    mocks.store.addPrompt.mockReset();
    mocks.store.addRevision.mockReset();
    mocks.store.updatePrompt.mockReset();
    mocks.store.deletePrompt.mockReset();
    mocks.store.toggleFavorite.mockReset();
    mocks.toast.mockReset();
    mocks.clipboardWriteText.mockReset();
    mocks.clipboardWriteText.mockResolvedValue(undefined);

    vi.stubGlobal('confirm', vi.fn().mockReturnValueOnce(false).mockReturnValue(true));
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: mocks.clipboardWriteText,
      },
    });
  });

  it('wires prompt actions, create flow, and edit flow', () => {
    render(<PromptManager />);

    fireEvent.click(screen.getByText('mock-filter'));
    expect(mocks.store.setFilter).toHaveBeenCalledWith({ search: 'updated-search' });

    fireEvent.click(screen.getByText('mock-favorite'));
    expect(mocks.store.toggleFavorite).toHaveBeenCalledWith('prompt-1');

    fireEvent.click(screen.getByText('mock-copy'));
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('copied content');
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Copied to clipboard' })
    );

    fireEvent.click(screen.getByText('mock-delete'));
    expect(mocks.store.deletePrompt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('mock-delete'));
    expect(mocks.store.deletePrompt).toHaveBeenCalledWith('prompt-1');
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Prompt deleted', variant: 'destructive' })
    );

    fireEvent.click(screen.getByText('mock-add-prompt'));
    expect(screen.getByText('creating-new')).toBeInTheDocument();

    fireEvent.click(screen.getByText('mock-save-invalid'));
    expect(mocks.store.addPrompt).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Error', variant: 'destructive' })
    );

    fireEvent.click(screen.getByText('mock-save-create'));
    expect(mocks.store.addPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Created prompt',
        content: 'Created content',
        categoryId: 'general',
        isFavorite: false,
      })
    );
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Prompt created' }));

    fireEvent.click(screen.getByText('mock-edit'));
    expect(screen.getByText('editing-prompt-1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('mock-save-edit'));
    expect(mocks.store.updatePrompt).toHaveBeenCalledWith(
      'prompt-1',
      expect.objectContaining({ title: 'Edited prompt title' })
    );
    expect(mocks.store.addRevision).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Prompt updated' }));

    fireEvent.click(screen.getByText('mock-edit'));
    fireEvent.click(screen.getByText('mock-save-content-edit'));
    expect(mocks.store.addRevision).toHaveBeenLastCalledWith(
      'prompt-1',
      expect.objectContaining({
        content: 'Existing prompt content',
        modelSettings: {
          model: 'openai:gpt-4o-mini',
          temperature: 0.4,
          topP: 0.8,
          maxTokens: 2048,
          frequencyPenalty: 0.1,
          presencePenalty: 0.2,
        },
        note: 'Before edit',
      })
    );
    expect(mocks.store.updatePrompt).toHaveBeenLastCalledWith(
      'prompt-1',
      expect.objectContaining({
        content: 'Edited prompt content',
        modelSettings: { model: 'openai:gpt-4.1-mini', temperature: 0.7, topP: 1 },
      })
    );

    fireEvent.click(screen.getByText('mock-edit'));
    fireEvent.click(screen.getByText('mock-save-restored-content'));
    expect(mocks.store.addRevision).toHaveBeenLastCalledWith(
      'prompt-1',
      expect.objectContaining({
        content: 'Existing prompt content',
        note: 'Before restore',
      })
    );
    const latestUpdate = mocks.store.updatePrompt.mock.calls.at(-1)?.[1];
    expect(latestUpdate).toEqual(
      expect.objectContaining({
        content: 'Restored prompt content',
        modelSettings: { model: 'openai:gpt-4.1-mini', temperature: 0.7, topP: 1 },
      })
    );
    expect(latestUpdate).not.toHaveProperty('revisionNote');

    fireEvent.click(screen.getByText('mock-close-editor'));
    expect(screen.queryByText('editing-prompt-1')).not.toBeInTheDocument();
  });

  it('does not version unchanged full model settings and versions optional setting edits', () => {
    render(<PromptManager />);

    fireEvent.click(screen.getByText('mock-edit'));
    fireEvent.click(screen.getByText('mock-save-same-full-settings'));
    expect(mocks.store.addRevision).not.toHaveBeenCalled();
    expect(mocks.store.updatePrompt).toHaveBeenCalledWith(
      'prompt-1',
      expect.objectContaining({
        title: 'Edited prompt title',
        modelSettings: mocks.store.prompts[0]?.modelSettings,
      })
    );

    fireEvent.click(screen.getByText('mock-edit'));
    fireEvent.click(screen.getByText('mock-save-presence-edit'));
    expect(mocks.store.addRevision).toHaveBeenCalledWith(
      'prompt-1',
      expect.objectContaining({
        content: 'Existing prompt content',
        modelSettings: mocks.store.prompts[0]?.modelSettings,
      })
    );
  });
});
