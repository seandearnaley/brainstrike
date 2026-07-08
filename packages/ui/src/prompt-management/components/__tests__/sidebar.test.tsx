import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Category, PromptFilter } from '../../types';
import { Sidebar } from '../sidebar';

const categories: Category[] = [
  { color: '#64748b', icon: 'Box', id: 'general', name: 'General' },
  { color: '#3b82f6', icon: 'Code', id: 'coding', name: 'Coding' },
];

const baseFilter: PromptFilter = {
  favoritesOnly: false,
  search: '',
  tags: [],
};

describe('Sidebar', () => {
  it('triggers add prompt and search filter updates', () => {
    const onAddPrompt = vi.fn();
    const onFilterChange = vi.fn();

    render(
      <Sidebar
        categories={categories}
        filter={baseFilter}
        onAddPrompt={onAddPrompt}
        onFilterChange={onFilterChange}
      />
    );

    fireEvent.click(screen.getByText('New Prompt'));
    expect(onAddPrompt).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText('Search prompts...'), {
      target: { value: 'refactor' },
    });
    expect(onFilterChange).toHaveBeenCalledWith({ search: 'refactor' });
  });

  it('triggers category and favorites quick filters', () => {
    const onFilterChange = vi.fn();

    render(
      <Sidebar
        categories={categories}
        filter={{ ...baseFilter, categoryId: 'coding' }}
        onAddPrompt={() => {}}
        onFilterChange={onFilterChange}
      />
    );

    fireEvent.click(screen.getByText('All Prompts'));
    expect(onFilterChange).toHaveBeenCalledWith({ categoryId: null, favoritesOnly: false });

    fireEvent.click(screen.getByText('Favorites'));
    expect(onFilterChange).toHaveBeenCalledWith({ categoryId: null, favoritesOnly: true });

    fireEvent.click(screen.getByText('Coding'));
    expect(onFilterChange).toHaveBeenCalledWith({ categoryId: 'coding', favoritesOnly: false });
  });

  it('renders category list and settings controls', () => {
    render(
      <Sidebar
        categories={categories}
        filter={baseFilter}
        onAddPrompt={() => {}}
        onFilterChange={() => {}}
      />
    );

    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Coding')).toBeInTheDocument();
    expect(screen.getByText('No tags yet')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});
