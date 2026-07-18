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
});
