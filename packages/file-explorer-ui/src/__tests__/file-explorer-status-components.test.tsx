import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DirectoryStatus, FilterStatus } from '../file-explorer-status-components';

describe('DirectoryStatus', () => {
  it('renders folder badge when handle is provided', () => {
    const handle: DirectoryHandle = {
      kind: 'directory',
      name: 'root',
      path: '/root',
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
      <TooltipProvider>
        <FilterStatus
          excludeFilters={['*.test.ts']}
          includeFilters={['*.ts']}
          quickFilter="bar"
          useRegex={true}
        />
      </TooltipProvider>
    );
    expect(screen.getByText('*.ts')).toBeInTheDocument();
    expect(screen.getByText('*.test.ts')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
    expect(screen.getByText('regex')).toBeInTheDocument();
  });

  it('returns null when no filters are active', () => {
    const { container } = render(
      <TooltipProvider>
        <FilterStatus excludeFilters={[]} includeFilters={[]} quickFilter="" useRegex={false} />
      </TooltipProvider>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders disabled include filter with strikethrough styling', () => {
    const disabledIncludeFilters = new Set(['*.ts']);
    render(
      <TooltipProvider>
        <FilterStatus
          disabledExcludeFilters={new Set()}
          disabledIncludeFilters={disabledIncludeFilters}
          excludeFilters={[]}
          includeFilters={['*.ts', '*.tsx']}
          quickFilter=""
          useRegex={false}
        />
      </TooltipProvider>
    );
    // The disabled filter should have line-through class on its text span
    const disabledChip = screen.getByText('*.ts');
    expect(disabledChip).toHaveClass('line-through');
    // The enabled filter should not have line-through
    const enabledChip = screen.getByText('*.tsx');
    expect(enabledChip).not.toHaveClass('line-through');
  });

  it('renders disabled exclude filter with strikethrough styling', () => {
    const disabledExcludeFilters = new Set(['node_modules']);
    render(
      <TooltipProvider>
        <FilterStatus
          disabledExcludeFilters={disabledExcludeFilters}
          disabledIncludeFilters={new Set()}
          excludeFilters={['node_modules', '.git']}
          includeFilters={[]}
          quickFilter=""
          useRegex={false}
        />
      </TooltipProvider>
    );
    const disabledChip = screen.getByText('node_modules');
    expect(disabledChip).toHaveClass('line-through');
    const enabledChip = screen.getByText('.git');
    expect(enabledChip).not.toHaveClass('line-through');
  });

  it('calls onToggleFilter when clicking an include filter chip', async () => {
    const user = userEvent.setup();
    const onToggleFilter = vi.fn();
    render(
      <TooltipProvider>
        <FilterStatus
          excludeFilters={[]}
          includeFilters={['*.ts']}
          onToggleFilter={onToggleFilter}
          quickFilter=""
          useRegex={false}
        />
      </TooltipProvider>
    );
    const chip = screen.getByText('*.ts');
    await user.click(chip);
    expect(onToggleFilter).toHaveBeenCalledWith('*.ts', 'include');
  });

  it('calls onToggleFilter when clicking an exclude filter chip', async () => {
    const user = userEvent.setup();
    const onToggleFilter = vi.fn();
    render(
      <TooltipProvider>
        <FilterStatus
          excludeFilters={['node_modules']}
          includeFilters={[]}
          onToggleFilter={onToggleFilter}
          quickFilter=""
          useRegex={false}
        />
      </TooltipProvider>
    );
    const chip = screen.getByText('node_modules');
    await user.click(chip);
    expect(onToggleFilter).toHaveBeenCalledWith('node_modules', 'exclude');
  });

  it('does not call onToggleFilter for quick filter or regex chips', async () => {
    const user = userEvent.setup();
    const onToggleFilter = vi.fn();
    render(
      <TooltipProvider>
        <FilterStatus
          excludeFilters={[]}
          includeFilters={[]}
          onToggleFilter={onToggleFilter}
          quickFilter="search"
          useRegex={true}
        />
      </TooltipProvider>
    );
    // Click on quick filter chip - should not trigger onToggleFilter
    const searchChip = screen.getByText('search');
    await user.click(searchChip);
    expect(onToggleFilter).not.toHaveBeenCalled();
    // Click on regex chip - should not trigger onToggleFilter
    const regexChip = screen.getByText('regex');
    await user.click(regexChip);
    expect(onToggleFilter).not.toHaveBeenCalled();
  });
});
