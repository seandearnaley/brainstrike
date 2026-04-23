import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { ThreadsPanel } from '../threads-panel';

describe('ThreadsPanel', () => {
  beforeEach(() => {
    useAssistantThreadStore.setState({ selectedThreadByResourceId: {} });
  });

  it('shows an explicit empty workspace thread state', () => {
    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-preview-badge')).toHaveTextContent('Preview');
    expect(screen.getByRole('button', { name: 'New thread' })).toBeDisabled();
    expect(screen.getByTestId('threads-placeholder-card')).toBeVisible();
    expect(screen.getByText('No workspace thread selected')).toBeVisible();
  });

  it('lists selected workspace-scoped thread IDs', () => {
    useAssistantThreadStore.setState({
      selectedThreadByResourceId: {
        '/tmp/workspace-a': 'thread-a',
      },
    });

    render(<ThreadsPanel />);

    expect(screen.getByTestId('thread-row')).toHaveTextContent('thread-a');
    expect(screen.getByTestId('thread-row')).toHaveTextContent('/tmp/workspace-a');
    expect(screen.getByRole('button', { name: 'New thread' })).toBeEnabled();
  });
});
