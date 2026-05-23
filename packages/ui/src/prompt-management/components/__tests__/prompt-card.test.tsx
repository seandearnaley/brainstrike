import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../tooltip';
import type { Category, Prompt } from '../../types';
import { PromptCard } from '../prompt-card';

const category: Category = {
  id: 'coding',
  name: 'Coding',
  color: '#3b82f6',
  icon: 'Code',
};

const prompt: Prompt = {
  id: 'prompt-1',
  title: 'Refactor React hook',
  content: 'Refactor this hook for better readability and performance.',
  categoryId: 'coding',
  tags: ['react', 'hooks', 'typescript', 'performance'],
  modelSettings: {
    model: 'openai:gpt-4o-mini',
    temperature: 0.4,
    topP: 1,
  },
  revisions: [],
  rating: 5,
  site: 'https://docs.example.com/guide',
  isFavorite: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_100,
};

describe('PromptCard', () => {
  const renderPromptCard = (ui: React.ReactElement) =>
    render(<TooltipProvider>{ui}</TooltipProvider>);

  it('renders prompt metadata and forwards actions', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onToggleFavorite = vi.fn();
    const onCopy = vi.fn();

    renderPromptCard(
      <PromptCard
        category={category}
        onCopy={onCopy}
        onDelete={onDelete}
        onEdit={onEdit}
        onToggleFavorite={onToggleFavorite}
        prompt={prompt}
      />
    );

    expect(screen.getByText('Refactor React hook')).toBeInTheDocument();
    expect(screen.getByText('Coding')).toBeInTheDocument();
    expect(screen.getByText('openai:gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText('docs.example.com')).toBeInTheDocument();
    expect(screen.getByText('#react')).toBeInTheDocument();
    expect(screen.getByText('#hooks')).toBeInTheDocument();
    expect(screen.getByText('#typescript')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onToggleFavorite).toHaveBeenCalledWith('prompt-1');

    fireEvent.pointerDown(buttons[1] as HTMLElement);
    fireEvent.click(screen.getByText('Copy Content'));
    fireEvent.pointerDown(buttons[1] as HTMLElement);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.pointerDown(buttons[1] as HTMLElement);
    fireEvent.click(screen.getByText('Delete'));

    expect(onCopy).toHaveBeenCalledWith(prompt.content);
    expect(onEdit).toHaveBeenCalledWith('prompt-1');
    expect(onDelete).toHaveBeenCalledWith('prompt-1');
  });

  it('renders uncategorized fallback when category is missing', () => {
    const { site: _site, ...promptWithoutSite } = prompt;

    renderPromptCard(
      <PromptCard
        onCopy={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
        onToggleFavorite={() => {}}
        prompt={promptWithoutSite}
      />
    );

    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
  });

  it('shows a hover hint for the more options control', async () => {
    const user = userEvent.setup();

    renderPromptCard(
      <PromptCard
        category={category}
        onCopy={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
        onToggleFavorite={() => {}}
        prompt={prompt}
      />
    );

    await user.hover(screen.getByRole('button', { name: 'More options' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('More options');
  });

  it('closes the more options hover hint while the menu is open', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();

    renderPromptCard(
      <PromptCard
        category={category}
        onCopy={onCopy}
        onDelete={() => {}}
        onEdit={() => {}}
        onToggleFavorite={() => {}}
        prompt={prompt}
      />
    );

    const moreOptions = screen.getByRole('button', { name: 'More options' });
    await user.hover(moreOptions);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More options');

    await user.click(moreOptions);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    await user.click(screen.getByRole('menuitem', { name: 'Copy Content' }));

    expect(onCopy).toHaveBeenCalledWith(prompt.content);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('restores the more options hover hint after keyboard menu close', async () => {
    const user = userEvent.setup();

    renderPromptCard(
      <PromptCard
        category={category}
        onCopy={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
        onToggleFavorite={() => {}}
        prompt={prompt}
      />
    );

    const moreOptions = screen.getByRole('button', { name: 'More options' });
    moreOptions.focus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    await user.hover(moreOptions);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More options');
  });

  it('does not add focusable controls for decorative metadata', () => {
    renderPromptCard(
      <PromptCard
        category={category}
        onCopy={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
        onToggleFavorite={() => {}}
        prompt={prompt}
      />
    );

    expect(screen.queryByRole('img', { name: 'Coding' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Coding' })).not.toBeInTheDocument();
    expect(screen.getByText('11/14/2023')).not.toHaveAttribute('tabindex');
  });
});
