import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Category, Prompt } from '../../types';
import { PromptList } from '../prompt-list';

vi.mock('../prompt-card', () => ({
  PromptCard: ({
    prompt,
    category,
    onEdit,
    onDelete,
    onToggleFavorite,
    onCopy,
  }: {
    prompt: Prompt;
    category?: Category;
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
    onToggleFavorite: (id: string) => void;
    onCopy: (content: string) => void;
  }) => (
    <div data-testid={`prompt-card-${prompt.id}`}>
      <span>{category?.name ?? 'no-category'}</span>
      <button onClick={() => onEdit(prompt.id)} type="button">
        edit
      </button>
      <button onClick={() => onDelete(prompt.id)} type="button">
        delete
      </button>
      <button onClick={() => onToggleFavorite(prompt.id)} type="button">
        favorite
      </button>
      <button onClick={() => onCopy(prompt.content)} type="button">
        copy
      </button>
    </div>
  ),
}));

const categories: Category[] = [
  { id: 'general', name: 'General', color: '#64748b', icon: 'Box' },
  { id: 'coding', name: 'Coding', color: '#3b82f6', icon: 'Code' },
];

const prompts: Prompt[] = [
  {
    id: 'p1',
    title: 'Refactor helper',
    content: 'Refactor this utility with strict typing.',
    categoryId: 'coding',
    tags: ['typescript', 'refactor'],
    modelSettings: { model: 'openai:gpt-4o-mini', temperature: 0.3, topP: 1 },
    revisions: [],
    rating: 5,
    isFavorite: true,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: 'p2',
    title: 'Email response',
    content: 'Write a concise email response for customer support.',
    categoryId: 'missing-category',
    tags: ['writing'],
    modelSettings: { model: 'openai:gpt-4o-mini', temperature: 0.5, topP: 1 },
    revisions: [],
    rating: 4,
    isFavorite: false,
    createdAt: 3,
    updatedAt: 4,
  },
];

describe('PromptList', () => {
  it('renders empty state when no prompts match', () => {
    render(
      <PromptList
        categories={categories}
        filter={{ search: '', tags: [], favoritesOnly: false }}
        onCopy={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
        onToggleFavorite={() => {}}
        prompts={[]}
      />
    );

    expect(screen.getByText('No prompts found')).toBeInTheDocument();
    expect(
      screen.getByText('Try adjusting your filters or create a new prompt.')
    ).toBeInTheDocument();
  });

  it('filters prompts by search, category, favorites, and tags and forwards actions', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onToggleFavorite = vi.fn();
    const onCopy = vi.fn();

    const { rerender } = render(
      <PromptList
        categories={categories}
        filter={{ search: 'refactor', tags: [], favoritesOnly: false }}
        onCopy={onCopy}
        onDelete={onDelete}
        onEdit={onEdit}
        onToggleFavorite={onToggleFavorite}
        prompts={prompts}
      />
    );

    expect(screen.getByTestId('prompt-card-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-card-p2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('edit'));
    fireEvent.click(screen.getByText('delete'));
    fireEvent.click(screen.getByText('favorite'));
    fireEvent.click(screen.getByText('copy'));

    expect(onEdit).toHaveBeenCalledWith('p1');
    expect(onDelete).toHaveBeenCalledWith('p1');
    expect(onToggleFavorite).toHaveBeenCalledWith('p1');
    expect(onCopy).toHaveBeenCalledWith('Refactor this utility with strict typing.');

    rerender(
      <PromptList
        categories={categories}
        filter={{ search: '', categoryId: 'coding', tags: ['typescript'], favoritesOnly: true }}
        onCopy={onCopy}
        onDelete={onDelete}
        onEdit={onEdit}
        onToggleFavorite={onToggleFavorite}
        prompts={prompts}
      />
    );
    expect(screen.getByTestId('prompt-card-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-card-p2')).not.toBeInTheDocument();

    rerender(
      <PromptList
        categories={categories}
        filter={{ search: '', tags: ['missing-tag'], favoritesOnly: false }}
        onCopy={onCopy}
        onDelete={onDelete}
        onEdit={onEdit}
        onToggleFavorite={onToggleFavorite}
        prompts={prompts}
      />
    );
    expect(screen.getByText('No prompts found')).toBeInTheDocument();
  });

  it('falls back to the first category when prompt category is missing', () => {
    render(
      <PromptList
        categories={categories}
        filter={{ search: 'email', tags: [], favoritesOnly: false }}
        onCopy={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
        onToggleFavorite={() => {}}
        prompts={prompts}
      />
    );

    expect(screen.getByText('General')).toBeInTheDocument();
  });
});
