import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileTabHeader } from '../file-tab-header';

describe('FileTabHeader', () => {
  it('shows filename and directory', () => {
    render(
      <FileTabHeader
        directory="/root/docs"
        fileName="readme.md"
        mode="preview"
        onModeChange={vi.fn()}
        showModeToggle={false}
      />
    );
    expect(screen.getByText('readme.md')).toBeInTheDocument();
    expect(screen.getByText('/root/docs')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tab-mode-toggle')).not.toBeInTheDocument();
  });

  it('renders the toggle only when showModeToggle, with the active mode pressed', () => {
    render(
      <FileTabHeader
        directory=""
        fileName="readme.md"
        mode="preview"
        onModeChange={vi.fn()}
        showModeToggle={true}
      />
    );
    expect(screen.getByTestId('file-tab-mode-toggle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preview/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /source/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('renders a copy button for the file contents when copyText is provided', () => {
    render(
      <FileTabHeader
        copyText="# Title\nbody"
        directory=""
        fileName="readme.md"
        mode="preview"
        onModeChange={vi.fn()}
        showModeToggle={true}
      />
    );
    expect(screen.getByRole('button', { name: 'Copy readme.md' })).toBeInTheDocument();
  });

  it('omits the copy button when copyText is absent (binary / inaccessible / loading tabs)', () => {
    render(
      <FileTabHeader
        copyText={null}
        directory=""
        fileName="readme.md"
        mode="source"
        onModeChange={vi.fn()}
        showModeToggle={false}
      />
    );
    expect(screen.queryByRole('button', { name: 'Copy readme.md' })).not.toBeInTheDocument();
  });

  it('fires onModeChange with the clicked mode', () => {
    const onModeChange = vi.fn();
    render(
      <FileTabHeader
        directory=""
        fileName="readme.md"
        mode="preview"
        onModeChange={onModeChange}
        showModeToggle={true}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /source/i }));
    expect(onModeChange).toHaveBeenCalledWith('source');
  });

  it('renders breadcrumbs instead of the plain identity spans when provided (BST-1269)', () => {
    const renderSegmentPopover = vi.fn(() => <div data-testid="segment-popover" />);
    render(
      <FileTabHeader
        breadcrumbs={{
          renderSegmentPopover,
          segments: [
            { label: 'src', path: '/r/src' },
            { label: 'a.ts', path: '/r/src/a.ts' },
          ],
        }}
        directory="/r/src"
        fileName="a.ts"
        mode="source"
        onModeChange={vi.fn()}
        showModeToggle={false}
      />
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('/r/src')).not.toBeInTheDocument();
    // Segments are popover triggers (BST-1319): clicking renders the picker.
    fireEvent.click(screen.getByRole('button', { name: 'src' }));
    expect(screen.getByTestId('segment-popover')).toBeInTheDocument();
  });

  it('renders the pane toggle with pressed state when wired (BST-1269)', () => {
    const onTogglePane = vi.fn();
    render(
      <FileTabHeader
        directory=""
        fileName="a.ts"
        isPaneOpen={true}
        mode="source"
        onModeChange={vi.fn()}
        onTogglePane={onTogglePane}
        showModeToggle={false}
      />
    );
    const toggle = screen.getByRole('button', { name: 'Toggle explorer pane' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(onTogglePane).toHaveBeenCalledTimes(1);
  });
});
