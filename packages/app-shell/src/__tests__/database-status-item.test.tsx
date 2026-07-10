import {
  __resetDatabaseStatusStoreForTests,
  useDatabaseStatusStore,
} from '@brainstrike/preferences';
import { act, render, screen } from '@testing-library/react';
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
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });

  it('announces meaningful database connection transitions', () => {
    render(<DatabaseStatusItem />);

    expect(screen.getByRole('status')).toHaveTextContent('Storage connecting');

    act(() => {
      useDatabaseStatusStore.getState().setConnected('Main Process', 'Connected (IPC)');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Storage connected: IPC');

    act(() => {
      useDatabaseStatusStore.getState().setDisconnected('Main Process', 'Connection failed');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Storage disconnected: IPC');
  });

  it('shows connected state with IPC location', () => {
    useDatabaseStatusStore.getState().setConnected('Main Process', 'Connected (IPC)');

    render(<DatabaseStatusItem />);

    expect(screen.getByTestId('status-bar-db-connected')).toBeInTheDocument();
    expect(screen.getByText('Storage: IPC')).toBeInTheDocument();
  });

  it('shows connected state with PGlite location', () => {
    useDatabaseStatusStore.getState().setConnected('PGlite WASM', 'connected');

    render(<DatabaseStatusItem />);

    expect(screen.getByTestId('status-bar-db-connected')).toBeInTheDocument();
    expect(screen.getByText('Storage: PGlite WASM')).toBeInTheDocument();
  });

  it('shows disconnected state', () => {
    useDatabaseStatusStore.getState().setDisconnected('Unknown', 'Connection failed');

    render(<DatabaseStatusItem />);

    expect(screen.getByTestId('status-bar-db-disconnected')).toBeInTheDocument();
  });

  it('uses PGlite as fallback when location is null', () => {
    // Manually set a connected state with null location
    useDatabaseStatusStore.setState({
      connected: true,
      loading: false,
      location: null,
      testResult: 'OK',
    });

    render(<DatabaseStatusItem />);

    expect(screen.getByText('Storage: PGlite')).toBeInTheDocument();
  });

  it('renders database icon', () => {
    render(<DatabaseStatusItem />);

    // The Database icon should be rendered as an SVG
    const statusItem = screen.getByTestId('status-bar-db-loading');
    expect(statusItem.querySelector('svg')).toBeInTheDocument();
  });
});
