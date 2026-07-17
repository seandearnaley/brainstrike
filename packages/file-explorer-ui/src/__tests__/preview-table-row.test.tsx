import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PreviewTableRow } from '../preview/preview-table-row';
import type { ColumnVisibility } from '../preview/use-preview-panel-persistence';
import type { TableRowData } from '../utils/grouping-configs';

describe('PreviewTableRow', () => {
  const mockItem: TableRowData = {
    compositeKey: 'file1',
    id: 'id1',
    path: '/src/components/Button.tsx',
    rootFolderId: 'root',
    size: 5120,
    tokens: 1500,
    type: 'tsx',
  };

  const defaultColumnVisibility: ColumnVisibility = {
    checkbox: true,
    path: true,
    rootFolderId: true,
    size: true,
    tokens: true,
    type: true,
  };

  const mockOnToggleSelection = vi.fn();
  const mockOnFileClick = vi.fn();

  it('renders all columns when visibility is enabled', () => {
    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={mockItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByLabelText('Select /src/components/Button.tsx')).toBeInTheDocument();
    expect(screen.getByText('root')).toBeInTheDocument();
    expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    expect(screen.getByText('root/src/components')).toBeInTheDocument();
    expect(screen.getByText('tsx')).toBeInTheDocument();
    expect(screen.getByText('1.5K')).toBeInTheDocument();
    expect(screen.getByText('5.0 KB')).toBeInTheDocument();
  });

  it('hides columns based on visibility settings', () => {
    const partialVisibility: ColumnVisibility = {
      checkbox: false,
      path: true,
      rootFolderId: false,
      size: false,
      tokens: false,
      type: false,
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={partialVisibility}
            isSelected={false}
            item={mockItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.queryByLabelText('Select /src/components/Button.tsx')).not.toBeInTheDocument();
    expect(screen.queryByText('root')).not.toBeInTheDocument();
    expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    expect(screen.queryByText('tsx')).not.toBeInTheDocument();
  });

  it('handles checkbox toggle', async () => {
    const user = userEvent.setup();

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={mockItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    const checkbox = screen.getByLabelText('Select /src/components/Button.tsx');
    await user.click(checkbox);

    expect(mockOnToggleSelection).toHaveBeenCalledWith('file1', true);
  });

  it('handles file click', async () => {
    const user = userEvent.setup();

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={mockItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    const fileButton = screen.getByLabelText('Button.tsx');
    await user.click(fileButton);

    expect(mockOnFileClick).toHaveBeenCalledWith('file1');
  });

  it('does not call onFileClick when undefined', async () => {
    const user = userEvent.setup();

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={mockItem}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    const fileButton = screen.getByLabelText('Button.tsx');
    await user.click(fileButton);

    expect(mockOnFileClick).not.toHaveBeenCalled();
  });

  it('renders em dash when tokens are undefined', () => {
    const { tokens: _tokens, ...rest } = mockItem;
    const itemWithoutTokens = rest as TableRowData;

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={itemWithoutTokens}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    const cells = screen.getAllByText('—');
    expect(cells.length).toBeGreaterThan(0);
  });

  it('renders "0" (not em dash) when tokens are zero for an indexed empty file', () => {
    // Empty files legitimately count to 0 tokens once indexed; rendering em
    // dash here falsely suggests the count is still pending. See the
    // context-explorer responsiveness fix that made the token cell use an
    // explicit `undefined` check instead of a falsy check.
    const emptyFileItem: TableRowData = { ...mockItem, tokens: 0 };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={emptyFileItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders em dash when size is undefined', () => {
    const { size: _size, ...rest } = mockItem;
    const itemWithoutSize = rest as TableRowData;

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={itemWithoutSize}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    const cells = screen.getAllByText('—');
    expect(cells.length).toBeGreaterThan(0);
  });

  it('handles file in root directory without subdirectory', () => {
    const rootFileItem: TableRowData = {
      compositeKey: 'file2',
      id: 'id2',
      path: 'README.md',
      rootFolderId: 'root',
      size: 2048,
      tokens: 500,
      type: 'md',
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={rootFileItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText('/')).not.toBeInTheDocument();
  });

  it('shows the root folder name for files in the root of an absolute folder path', () => {
    const absoluteRootItem: TableRowData = {
      ...mockItem,
      compositeKey: 'file-absolute-root',
      id: 'id-root-absolute',
      path: '/Users/me/project/file.txt',
      rootFolderId: 'project',
      type: 'TXT',
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={absoluteRootItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('file.txt')).toBeInTheDocument();
    expect(screen.getAllByText('project')).toHaveLength(2);
  });

  it('parses Windows path separators and prefixes the directory path with the root folder', () => {
    const windowsPath = 'C:\\Users\\me\\project\\src\\components\\Button.tsx';
    const windowsItem: TableRowData = {
      ...mockItem,
      path: windowsPath,
      rootFolderId: 'project',
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={windowsItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByLabelText(`Select ${windowsPath}`)).toBeInTheDocument();
    expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    expect(screen.getByText('project/src/components')).toBeInTheDocument();
  });

  it('displays the full root identity when the root identity is absolute', () => {
    const absoluteRootItem: TableRowData = {
      ...mockItem,
      path: '/Users/me/project/src/components/Button.tsx',
      rootFolderId: '/Users/me/project',
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={absoluteRootItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('/Users/me/project')).toBeInTheDocument();
    expect(screen.getByText('project/src/components')).toBeInTheDocument();
  });

  it('shortens long absolute directory paths to avoid horizontal scrolling', () => {
    const longPath =
      '/Users/me/Projects/brainstrike/packages/file-explorer-ui/src/components/very/deep/__tests__/PreviewTableRow.test.tsx';
    const longItem: TableRowData = {
      ...mockItem,
      path: longPath,
      rootFolderId: 'brainstrike',
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={longItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('PreviewTableRow.test.tsx')).toBeInTheDocument();
    expect(screen.getByText('brainstrike/packages/…/deep/__tests__')).toBeInTheDocument();
  });

  it('displays selected state correctly', () => {
    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={true}
            item={mockItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    const checkbox = screen.getByLabelText('Select /src/components/Button.tsx');
    expect(checkbox).toBeChecked();
  });

  it('formats large token counts correctly', () => {
    const largeTokenItem = { ...mockItem, tokens: 1_500_000 };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={largeTokenItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('1.5M')).toBeInTheDocument();
  });

  it('formats file sizes in KB correctly', () => {
    const largeFileItem = { ...mockItem, size: 10_240 };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={largeFileItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('10.0 KB')).toBeInTheDocument();
  });

  it('stops propagation on checkbox click', async () => {
    const user = userEvent.setup();
    const rowClickHandler = vi.fn();

    render(
      <table>
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: Testing click propagation */}
        <tbody
          onClick={rowClickHandler}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              rowClickHandler();
            }
          }}
        >
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={mockItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    const checkbox = screen.getByLabelText('Select /src/components/Button.tsx');
    await user.click(checkbox);

    expect(mockOnToggleSelection).toHaveBeenCalled();
    // Row click should not be triggered due to stopPropagation
    expect(rowClickHandler).not.toHaveBeenCalled();
  });

  it('renders extension badge with colored styling for type column', () => {
    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={mockItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    const badge = screen.getByText('tsx');
    expect(badge).toBeInTheDocument();
    // Badge should have inline color styles from the hash-based color system
    const badgeContainer = badge.closest('[style]');
    expect(badgeContainer).not.toBeNull();
  });

  it('renders FILE type for files without extensions', () => {
    const noExtItem: TableRowData = {
      ...mockItem,
      compositeKey: 'file-noext',
      id: 'id-noext',
      path: '/src/Makefile',
      type: 'file',
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            columnVisibility={defaultColumnVisibility}
            isSelected={false}
            item={noExtItem}
            onFileClick={mockOnFileClick}
            onToggleSelection={mockOnToggleSelection}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('file')).toBeInTheDocument();
  });
});
