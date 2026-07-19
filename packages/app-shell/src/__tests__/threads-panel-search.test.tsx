import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMemoryThread } from '../assistant-memory-repository';
import { resetThreadSearchStore, useThreadSearchStore } from '../thread-search-store';
import { renderMarkedText, ThreadsPanelSearch } from '../threads-panel-search';

const THREAD: AssistantMemoryThread = {
  createdAt: new Date('2026-07-01T00:00:00Z'),
  id: 'thread-1',
  resourceId: 'workspace-memory',
  title: 'HNSW tuning',
  updatedAt: new Date('2026-07-02T00:00:00Z'),
};

const MATCH = {
  headline: 'tune <mark>hnsw</mark> parameters',
  messageCreatedAt: new Date('2026-07-02T00:00:00Z'),
  messageId: 'msg-1',
  role: 'assistant',
  rrfScore: 0.5,
  sources: ['fts'] as const,
};

const RESULT = {
  matches: [MATCH],
  score: 1,
  threadId: 'thread-1',
  title: null,
  titleMatched: false,
};

function renderSearch(overrides: Partial<Parameters<typeof ThreadsPanelSearch>[0]> = {}) {
  const onSelectThread = vi.fn();
  const onRetry = vi.fn();
  render(
    <ThreadsPanelSearch
      groupNameByThreadId={new Map([['thread-1', 'Research']])}
      onRetry={onRetry}
      onSelectThread={onSelectThread}
      threadsById={new Map([[THREAD.id, THREAD]])}
      {...overrides}
    />
  );
  return { onRetry, onSelectThread };
}

describe('renderMarkedText', () => {
  it('turns <mark> tokens into elements and leaves other content as text', () => {
    render(<p>{renderMarkedText('a <mark>b</mark> c <script>x</script>')}</p>);
    const mark = screen.getByText('b');
    expect(mark.tagName).toBe('MARK');
    // Angle-bracket content outside <mark> stays literal text, never HTML.
    expect(screen.getByText(/<script>x<\/script>/)).toBeInTheDocument();
  });
});

describe('ThreadsPanelSearch', () => {
  beforeEach(() => {
    resetThreadSearchStore();
  });

  it('renders only the input when idle', () => {
    renderSearch();
    expect(screen.getByTestId('thread-search-input')).toBeInTheDocument();
    expect(screen.queryByTestId('thread-search-result')).not.toBeInTheDocument();
  });

  it('renders results with highlighted snippets and folder badges', () => {
    useThreadSearchStore.setState({
      query: 'hnsw',
      results: [RESULT],
      semantic: { kind: 'used' },
      status: 'results',
    });
    const { onSelectThread } = renderSearch();

    const result = screen.getByTestId('thread-search-result');
    expect(result).toHaveTextContent('HNSW tuning');
    expect(result).toHaveTextContent('Research');
    expect(result.querySelector('mark')?.textContent).toBe('hnsw');

    fireEvent.click(result);
    expect(onSelectThread).toHaveBeenCalledWith('thread-1');
  });

  it('supports keyboard navigation from the input', () => {
    useThreadSearchStore.setState({
      query: 'hnsw',
      results: [RESULT, { ...RESULT, threadId: 'thread-2', title: 'Other' }],
      semantic: { kind: 'used' },
      status: 'results',
    });
    const { onSelectThread } = renderSearch();
    const input = screen.getByTestId('thread-search-input');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectThread).toHaveBeenCalledWith('thread-2');
  });

  it('Escape clears the search', () => {
    useThreadSearchStore.setState({
      query: 'hnsw',
      results: [RESULT],
      semantic: { kind: 'used' },
      status: 'results',
    });
    renderSearch();

    fireEvent.keyDown(screen.getByTestId('thread-search-input'), { key: 'Escape' });
    expect(useThreadSearchStore.getState().query).toBe('');
    expect(useThreadSearchStore.getState().status).toBe('idle');
  });

  it('shows the semantic-unavailable notice with the reason as a tooltip', () => {
    useThreadSearchStore.setState({
      query: 'hnsw',
      results: [RESULT],
      semantic: { kind: 'unavailable', reason: 'No embedding queue is registered.' },
      status: 'results',
    });
    renderSearch();

    const notice = screen.getByTestId('thread-search-semantic-unavailable');
    expect(notice).toHaveTextContent(/keyword matches only/i);
    expect(notice).toHaveAttribute('title', 'No embedding queue is registered.');
  });

  it('shows embedding indexing progress from coverage', () => {
    useThreadSearchStore.setState({
      coverage: {
        embeddableMessages: 10,
        embeddedMessages: 4,
        erroredMessages: 1,
        indexedMessages: 12,
        totalMessages: 12,
      },
      query: 'hnsw',
      results: [RESULT],
      semantic: { kind: 'used' },
      status: 'results',
    });
    renderSearch();

    expect(screen.getByTestId('thread-search-indexing-progress')).toHaveTextContent('4 of 10');
  });

  it('surfaces embedding failures instead of silently shrinking coverage', () => {
    useThreadSearchStore.setState({
      coverage: {
        embeddableMessages: 10,
        embeddedMessages: 7,
        erroredMessages: 3,
        indexedMessages: 12,
        totalMessages: 12,
      },
      query: 'hnsw',
      results: [RESULT],
      semantic: { kind: 'used' },
      status: 'results',
    });
    renderSearch();

    expect(screen.getByTestId('thread-search-embedding-errors')).toHaveTextContent(
      '3 messages could not be embedded'
    );
  });

  it('renders the empty state honestly', () => {
    useThreadSearchStore.setState({
      query: 'zzz',
      results: [],
      semantic: { kind: 'used' },
      status: 'results',
    });
    renderSearch();
    expect(screen.getByTestId('thread-search-empty')).toBeInTheDocument();
  });

  it('renders the error state with a retry affordance', () => {
    useThreadSearchStore.setState({
      error: 'index unavailable',
      query: 'hnsw',
      status: 'error',
    });
    const { onRetry } = renderSearch();

    expect(screen.getByTestId('thread-search-error')).toHaveTextContent('index unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
