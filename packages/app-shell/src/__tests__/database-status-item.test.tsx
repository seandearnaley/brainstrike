import {
  __resetDatabaseStatusStoreForTests,
  useDatabaseStatusStore,
} from '@brainstrike/app-state/stores/database-status-store';
import { act } from '@brainstrike/test-utils/react-act';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseStatusItem } from '../status-items/database-status-item';

describe('DatabaseStatusItem', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
  });

  it('shows loading state when database is connecting', () => {
    // Initial state is loading
    render(<DatabaseStatusItem />);

    expect(screen.getByTestId('status-bar-db-loading')).toBeInTheDocument();
    expect(screen.getByText('Storage:')).toBeInTheDocument();
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
  });

  it('announces meaningful database connection transitions', () => {
    render(<DatabaseStatusItem />);

    expect(screen.getByRole('status')).toHaveTextContent('Storage connecting');

    act(() => {
      useDatabaseStatusStore.getState().setConnected('SQLite', 'Connected (agent host)');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Storage connected');

    act(() => {
      useDatabaseStatusStore.getState().setDisconnected('SQLite', 'Connection failed');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Storage disconnected');
  });

  it('shows connected state without naming the storage engine', () => {
    useDatabaseStatusStore.getState().setConnected('SQLite', 'Connected (agent host)');

    render(<DatabaseStatusItem />);

    expect(screen.getByTestId('status-bar-db-connected')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar-db-connected')).toHaveClass(
      'w-40',
      'max-w-full',
      'shrink-0',
      'overflow-hidden',
      'whitespace-nowrap'
    );
    expect(screen.getByText('Storage:')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText(/SQLite/u)).not.toBeInTheDocument();
  });

  it('shows disconnected state', () => {
    useDatabaseStatusStore.getState().setDisconnected('Unknown', 'Connection failed');

    render(<DatabaseStatusItem />);

    expect(screen.getByTestId('status-bar-db-disconnected')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('shows connected state when location is null', () => {
    // Manually set a connected state with null location
    useDatabaseStatusStore.setState({
      connected: true,
      loading: false,
      location: null,
      testResult: 'OK',
    });

    render(<DatabaseStatusItem />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('renders database icon', () => {
    render(<DatabaseStatusItem />);

    // The Database icon should be rendered as an SVG
    const statusItem = screen.getByTestId('status-bar-db-loading');
    expect(statusItem.querySelector('svg')).toBeInTheDocument();
  });
});
