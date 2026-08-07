import {
  useAssistantThreadGroupsStore,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import type { QueueAdapter } from '@brainstrike/queue';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab-chunk';

let capturedDatabaseProps: {
  embeddingQueue?: QueueAdapter | null;
  onDatabaseCleared: () => void;
} | null = null;

// Mock dependencies
vi.mock('@brainstrike/db-explorer/database-demo-panel', () => ({
  DatabaseDemoPanel: (props: {
    embeddingQueue?: QueueAdapter | null;
    onDatabaseCleared: () => void;
  }) => {
    capturedDatabaseProps = props;
    return <div data-testid="database-demo-panel">DatabaseDemoPanel</div>;
  },
}));

describe('DatabaseTab (chunk)', () => {
  beforeEach(() => {
    capturedDatabaseProps = null;
  });

  it('renders DatabaseDemoPanel', () => {
    const { getByTestId } = render(<DatabaseTab />);

    expect(getByTestId('database-demo-panel')).toBeInTheDocument();
  });

  it('passes embeddingQueue prop to DatabaseDemoPanel', () => {
    const mockQueue = {
      add: vi.fn(),
      addBulk: vi.fn(),
      drain: vi.fn(),
      onProgress: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as QueueAdapter;

    render(<DatabaseTab embeddingQueue={mockQueue} />);

    expect(capturedDatabaseProps).not.toBeNull();
    expect(capturedDatabaseProps?.embeddingQueue).toBe(mockQueue);
  });

  it('passes null when no embeddingQueue is provided', () => {
    render(<DatabaseTab />);

    expect(capturedDatabaseProps).not.toBeNull();
    expect(capturedDatabaseProps?.embeddingQueue).toBeNull();
  });

  it('resets live assistant thread and group state after the database clears', () => {
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { 'resource-1': 'thread-1' },
      selectedThreadByResourceId: { 'resource-1': 'thread-1' },
      threadIdsByResourceId: { 'resource-1': ['thread-1'] },
    });
    useAssistantThreadGroupsStore.setState({
      groupsByResourceId: {
        'resource-1': [
          {
            color: null,
            icon: null,
            id: 'group-1',
            name: 'Group 1',
            rank: 'a0',
            resourceId: 'resource-1',
          },
        ],
      },
    });

    render(<DatabaseTab />);
    capturedDatabaseProps?.onDatabaseCleared();

    expect(useAssistantThreadStore.getState().selectedThreadByResourceId).toEqual({});
    expect(useAssistantThreadStore.getState().threadIdsByResourceId).toEqual({});
    expect(useAssistantThreadGroupsStore.getState().groupsByResourceId).toEqual({});
  });
});
