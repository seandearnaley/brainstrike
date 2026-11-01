import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';
import { SearchInputBar } from '../search-input-bar';

describe('SearchInputBar', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
    vi.clearAllMocks();
  });

  it('renders the three toggle buttons reflecting store state', () => {
    render(<SearchInputBar onSubmit={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Match whole word' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Use regular expression' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('clicking a toggle button flips the store flag and its aria-pressed state', () => {
    render(<SearchInputBar onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));

    expect(useWorkspaceSearchStore.getState().caseSensitive).toBe(true);
    expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('typing in the input updates the store query', () => {
    render(<SearchInputBar onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Search workspace'), {
      target: { value: 'findMe' },
    });

    expect(useWorkspaceSearchStore.getState().query).toBe('findMe');
  });

  it('Enter calls onSubmit', () => {
    const onSubmit = vi.fn();
    render(<SearchInputBar onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows a parser alert for an invalid regex and blocks Enter from submitting', () => {
    useWorkspaceSearchStore.getState().toggleRegex();
    const onSubmit = vi.fn();
    render(<SearchInputBar onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('Search workspace'), {
      target: { value: '(' },
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/./u);

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a valid regex renders no alert and Enter calls onSubmit', () => {
    useWorkspaceSearchStore.getState().toggleRegex();
    const onSubmit = vi.fn();
    render(<SearchInputBar onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('Search workspace'), {
      target: { value: 'valid.*pattern' },
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
