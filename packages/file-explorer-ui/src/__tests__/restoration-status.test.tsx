/**
 * Tests for RestorationStatus component
 *
 * Tests the restoration progress indicator that shows when the app is
 * restoring previously expanded directories from persisted state.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RestorationStatus } from '../restoration-status';

describe('RestorationStatus', () => {
  describe('when not restoring', () => {
    it('should render nothing when isRestoring is false', () => {
      const { container } = render(<RestorationStatus isRestoring={false} progress={null} />);
      expect(container.firstChild).toBeNull();
    });

    it('should render nothing with progress but isRestoring is false', () => {
      const { container } = render(
        <RestorationStatus
          isRestoring={false}
          progress={{ loaded: 5, total: 10, currentPath: '/test/path' }}
        />
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('when restoring', () => {
    it('should render status when isRestoring is true', () => {
      render(<RestorationStatus isRestoring={true} progress={null} />);
      expect(screen.getByTestId('restoration-status')).toBeInTheDocument();
    });

    it('should show default text when progress is null', () => {
      render(<RestorationStatus isRestoring={true} progress={null} />);
      expect(screen.getByText('Restoring folders...')).toBeInTheDocument();
      expect(screen.getByText('0%')).toBeInTheDocument();
    });

    it('should show progress count when progress is provided', () => {
      render(
        <RestorationStatus
          isRestoring={true}
          progress={{ loaded: 5, total: 10, currentPath: '/test/path' }}
        />
      );
      expect(screen.getByText('Restoring 5/10 folders')).toBeInTheDocument();
      expect(screen.getByText('50%')).toBeInTheDocument();
    });

    it('should show 0% when total is 0', () => {
      render(
        <RestorationStatus isRestoring={true} progress={{ loaded: 0, total: 0, currentPath: '' }} />
      );
      expect(screen.getByText('0%')).toBeInTheDocument();
    });

    it('should format long paths with ellipsis', () => {
      render(
        <RestorationStatus
          isRestoring={true}
          progress={{
            loaded: 3,
            total: 10,
            currentPath: '/root/parent/child/subdir',
          }}
        />
      );
      expect(screen.getByText('.../child/subdir')).toBeInTheDocument();
    });

    it('should show short paths without ellipsis', () => {
      render(
        <RestorationStatus
          isRestoring={true}
          progress={{ loaded: 3, total: 10, currentPath: 'folder/file' }}
        />
      );
      expect(screen.getByText('folder/file')).toBeInTheDocument();
    });

    it('should not show path when currentPath is empty', () => {
      render(
        <RestorationStatus
          isRestoring={true}
          progress={{ loaded: 3, total: 10, currentPath: '' }}
        />
      );
      // Should only have the status text, not the empty path
      expect(screen.queryByTitle('')).not.toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<RestorationStatus className="custom-class" isRestoring={true} progress={null} />);
      expect(screen.getByTestId('restoration-status')).toHaveClass('custom-class');
    });

    it('should calculate correct percentage for various values', () => {
      const { rerender } = render(
        <RestorationStatus isRestoring={true} progress={{ loaded: 1, total: 4, currentPath: '' }} />
      );
      expect(screen.getByText('25%')).toBeInTheDocument();

      rerender(
        <RestorationStatus isRestoring={true} progress={{ loaded: 3, total: 4, currentPath: '' }} />
      );
      expect(screen.getByText('75%')).toBeInTheDocument();

      rerender(
        <RestorationStatus
          isRestoring={true}
          progress={{ loaded: 10, total: 10, currentPath: '' }}
        />
      );
      expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('should show full path in title attribute', () => {
      const fullPath = '/root/parent/child/subdir';
      render(
        <RestorationStatus
          isRestoring={true}
          progress={{ loaded: 3, total: 10, currentPath: fullPath }}
        />
      );
      expect(screen.getByTitle(fullPath)).toBeInTheDocument();
    });
  });
});
