import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DbInfoDisplayProps } from '../../types';
import { DbInfoDisplay } from '../db-info-display';

describe('DbInfoDisplay', () => {
  describe('loading state (null dbInfo)', () => {
    it('renders loading state when dbInfo is null', () => {
      render(<DbInfoDisplay dbInfo={null} />);

      const container = screen.getByTestId('db-info');
      expect(container).toBeInTheDocument();
      expect(container).toHaveClass('mt-2', 'p-2', 'bg-muted', 'rounded', 'text-xs');
    });

    it('shows "Storage: Connecting..." text in loading state', () => {
      render(<DbInfoDisplay dbInfo={null} />);

      expect(screen.getByText('Storage: Connecting...')).toBeInTheDocument();
      expect(screen.getByText('Storage: Connecting...')).toHaveClass('font-medium');
    });

    it('shows "Testing database connection..." text in loading state', () => {
      render(<DbInfoDisplay dbInfo={null} />);

      expect(screen.getByText('Testing database connection...')).toBeInTheDocument();
      expect(screen.getByText('Testing database connection...')).toHaveClass(
        'mt-1',
        'text-muted-foreground'
      );
    });

    it('data-testid="db-info" is present in loading state', () => {
      render(<DbInfoDisplay dbInfo={null} />);

      expect(screen.getByTestId('db-info')).toBeInTheDocument();
    });
  });

  describe('connected state', () => {
    const connectedDbInfo: DbInfoDisplayProps['dbInfo'] = {
      location: '/path/to/database.db',
      testResult: 'Connected successfully',
      connected: true,
    };

    it('renders connected state with database location', () => {
      render(<DbInfoDisplay dbInfo={connectedDbInfo} />);

      expect(screen.getByText('Storage: /path/to/database.db')).toBeInTheDocument();
      expect(screen.getByText('Storage: /path/to/database.db')).toHaveClass('font-medium');
    });

    it('shows success indicator and test result when connected', () => {
      render(<DbInfoDisplay dbInfo={connectedDbInfo} />);

      const status = screen.getByTestId('db-status-connected');
      expect(status).toBeInTheDocument();
      expect(status).toHaveClass('text-green-600');
      expect(status).toHaveTextContent('✓ Connected successfully');
    });

    it('data-testid="db-info" is present in connected state', () => {
      render(<DbInfoDisplay dbInfo={connectedDbInfo} />);

      expect(screen.getByTestId('db-info')).toBeInTheDocument();
    });
  });

  describe('disconnected state', () => {
    const disconnectedDbInfo: DbInfoDisplayProps['dbInfo'] = {
      location: '/path/to/database.db',
      testResult: 'Connection failed',
      connected: false,
    };

    it('renders disconnected state with database location', () => {
      render(<DbInfoDisplay dbInfo={disconnectedDbInfo} />);

      expect(screen.getByText('Storage: /path/to/database.db')).toBeInTheDocument();
    });

    it('shows failure indicator and test result when disconnected', () => {
      render(<DbInfoDisplay dbInfo={disconnectedDbInfo} />);

      const status = screen.getByTestId('db-status-disconnected');
      expect(status).toBeInTheDocument();
      expect(status).toHaveClass('text-red-600');
      expect(status).toHaveTextContent('✗ Connection failed');
    });
  });

  describe('state transitions', () => {
    it('transitions from loading to connected state when dbInfo updates', () => {
      const { rerender } = render(<DbInfoDisplay dbInfo={null} />);

      // Initially in loading state
      expect(screen.getByText('Storage: Connecting...')).toBeInTheDocument();
      expect(screen.getByText('Testing database connection...')).toBeInTheDocument();

      // Update to connected state
      const connectedDbInfo: DbInfoDisplayProps['dbInfo'] = {
        location: '/data/app.db',
        testResult: 'Database ready',
        connected: true,
      };
      rerender(<DbInfoDisplay dbInfo={connectedDbInfo} />);

      // Should now show connected state
      expect(screen.queryByText('Storage: Connecting...')).not.toBeInTheDocument();
      expect(screen.queryByText('Testing database connection...')).not.toBeInTheDocument();
      expect(screen.getByText('Storage: /data/app.db')).toBeInTheDocument();
      expect(screen.getByText('✓ Database ready')).toBeInTheDocument();
      expect(screen.getByTestId('db-status-connected')).toBeInTheDocument();
    });

    it('transitions from loading to disconnected state when dbInfo updates', () => {
      const { rerender } = render(<DbInfoDisplay dbInfo={null} />);

      // Initially in loading state
      expect(screen.getByText('Storage: Connecting...')).toBeInTheDocument();

      // Update to disconnected state
      const disconnectedDbInfo: DbInfoDisplayProps['dbInfo'] = {
        location: '/data/failed.db',
        testResult: 'Failed to connect',
        connected: false,
      };
      rerender(<DbInfoDisplay dbInfo={disconnectedDbInfo} />);

      // Should now show disconnected state
      expect(screen.queryByText('Storage: Connecting...')).not.toBeInTheDocument();
      expect(screen.getByText('Storage: /data/failed.db')).toBeInTheDocument();
      expect(screen.getByText('✗ Failed to connect')).toBeInTheDocument();
      expect(screen.getByTestId('db-status-disconnected')).toBeInTheDocument();
    });

    it('maintains data-testid consistency across state transitions', () => {
      const { rerender } = render(<DbInfoDisplay dbInfo={null} />);

      // Loading state has data-testid
      expect(screen.getByTestId('db-info')).toBeInTheDocument();

      // Connected state maintains data-testid
      const connectedDbInfo: DbInfoDisplayProps['dbInfo'] = {
        location: '/test.db',
        testResult: 'OK',
        connected: true,
      };
      rerender(<DbInfoDisplay dbInfo={connectedDbInfo} />);
      expect(screen.getByTestId('db-info')).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('handles empty location string', () => {
      const dbInfo: DbInfoDisplayProps['dbInfo'] = {
        location: '',
        testResult: 'Connected',
        connected: true,
      };

      render(<DbInfoDisplay dbInfo={dbInfo} />);

      expect(screen.getByText('Storage:')).toBeInTheDocument();
      expect(screen.getByText('✓ Connected')).toBeInTheDocument();
    });

    it('handles empty test result string', () => {
      const dbInfo: DbInfoDisplayProps['dbInfo'] = {
        location: '/data/test.db',
        testResult: '',
        connected: true,
      };

      render(<DbInfoDisplay dbInfo={dbInfo} />);

      expect(screen.getByText('Storage: /data/test.db')).toBeInTheDocument();
      const status = screen.getByTestId('db-status-connected');
      expect(status).toHaveTextContent('✓');
    });

    it('handles special characters in location path', () => {
      const dbInfo: DbInfoDisplayProps['dbInfo'] = {
        location: '/path/with spaces/and-special_chars (123)/db.db',
        testResult: 'Connected',
        connected: true,
      };

      render(<DbInfoDisplay dbInfo={dbInfo} />);

      expect(
        screen.getByText('Storage: /path/with spaces/and-special_chars (123)/db.db')
      ).toBeInTheDocument();
    });

    it('handles special characters in test result', () => {
      const dbInfo: DbInfoDisplayProps['dbInfo'] = {
        location: '/test.db',
        testResult: 'Connected ✓ (v1.2.3) — OK!',
        connected: true,
      };

      render(<DbInfoDisplay dbInfo={dbInfo} />);

      expect(screen.getByText(/Connected ✓ \(v1\.2\.3\) — OK!/)).toBeInTheDocument();
    });
  });
});
