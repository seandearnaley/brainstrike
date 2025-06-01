import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DirectoryStatus, FilterStatus } from '../file-explorer-status-components';

describe('DirectoryStatus', () => {
  it('renders folder badge when handle is provided', () => {
    const handle: DirectoryHandle = {
      path: '/root',
      name: 'root',
      kind: 'directory',
      platform: 'web',
    };
    render(<DirectoryStatus rootDirectoryHandle={handle} />);
    expect(screen.getByText(FileExplorerStrings.status.currentDirectory)).toBeInTheDocument();
    expect(screen.getByText('root')).toBeInTheDocument();
  });

  it('returns null when handle is not provided', () => {
    const { container } = render(<DirectoryStatus rootDirectoryHandle={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('FilterStatus', () => {
  it('shows badges for include, exclude, quick filter and regex mode', () => {
    render(
      <FilterStatus
        includeFilters={['*.ts']}
        excludeFilters={['*.test.ts']}
        quickFilter="bar"
        useRegex={true}
      />
    );
    expect(screen.getByText('*.ts')).toBeInTheDocument();
    expect(screen.getByText('*.test.ts')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
    expect(screen.getByText('regex')).toBeInTheDocument();
  });

  it('returns null when no filters are active', () => {
    const { container } = render(
      <FilterStatus includeFilters={[]} excludeFilters={[]} quickFilter="" useRegex={false} />
    );
    expect(container.firstChild).toBeNull();
  });
});
