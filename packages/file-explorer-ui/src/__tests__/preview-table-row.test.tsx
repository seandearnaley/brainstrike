import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ColumnVisibility } from '../hooks/use-preview-panel-persistence';
import { PreviewTableRow } from '../preview-table-row';
import type { TableRowData } from '../utils/grouping-configs';

describe('PreviewTableRow', () => {
  const mockItem: TableRowData = {
    id: 'id1',
    compositeKey: 'file1',
    rootFolderId: 'root',
    path: '/src/components/Button.tsx',
    type: 'file',
    tokens: 1500,
    size: 5120,
  };

  const defaultColumnVisibility: ColumnVisibility = {
    checkbox: true,
    rootFolderId: true,
    path: true,
    type: true,
    tokens: true,
    size: true,
  };

  const mockOnToggleSelection = vi.fn();
  const mockOnFileClick = vi.fn();

  it('renders all columns when visibility is enabled', () => {
    render(
      <table>
        <tbody>
          <PreviewTableRow
            item={mockItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
          />
        </tbody>
      </table>
    );

    expect(screen.getByLabelText('Select /src/components/Button.tsx')).toBeInTheDocument();
    expect(screen.getByText('root')).toBeInTheDocument();
    expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    expect(screen.getByText('/src/components')).toBeInTheDocument();
    expect(screen.getByText('file')).toBeInTheDocument();
    expect(screen.getByText('1.5K')).toBeInTheDocument();
    expect(screen.getByText('5.0 KB')).toBeInTheDocument();
  });

  it('hides columns based on visibility settings', () => {
    const partialVisibility: ColumnVisibility = {
      checkbox: false,
      rootFolderId: false,
      path: true,
      type: false,
      tokens: false,
      size: false,
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            item={mockItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={partialVisibility}
          />
        </tbody>
      </table>
    );

    expect(screen.queryByLabelText('Select /src/components/Button.tsx')).not.toBeInTheDocument();
    expect(screen.queryByText('root')).not.toBeInTheDocument();
    expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    expect(screen.queryByText('file')).not.toBeInTheDocument();
  });

  it('handles checkbox toggle', async () => {
    const user = userEvent.setup();

    render(
      <table>
        <tbody>
          <PreviewTableRow
            item={mockItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
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
            item={mockItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
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
            item={mockItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            columnVisibility={defaultColumnVisibility}
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
            item={itemWithoutTokens}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
          />
        </tbody>
      </table>
    );

    const cells = screen.getAllByText('—');
    expect(cells.length).toBeGreaterThan(0);
  });

  it('renders em dash when size is undefined', () => {
    const { size: _size, ...rest } = mockItem;
    const itemWithoutSize = rest as TableRowData;

    render(
      <table>
        <tbody>
          <PreviewTableRow
            item={itemWithoutSize}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
          />
        </tbody>
      </table>
    );

    const cells = screen.getAllByText('—');
    expect(cells.length).toBeGreaterThan(0);
  });

  it('handles file in root directory without subdirectory', () => {
    const rootFileItem: TableRowData = {
      id: 'id2',
      compositeKey: 'file2',
      rootFolderId: 'root',
      path: 'README.md',
      type: 'file',
      tokens: 500,
      size: 2048,
    };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            item={rootFileItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText('/')).not.toBeInTheDocument();
  });

  it('displays selected state correctly', () => {
    render(
      <table>
        <tbody>
          <PreviewTableRow
            item={mockItem}
            isSelected={true}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
          />
        </tbody>
      </table>
    );

    const checkbox = screen.getByLabelText('Select /src/components/Button.tsx');
    expect(checkbox).toBeChecked();
  });

  it('formats large token counts correctly', () => {
    const largeTokenItem = { ...mockItem, tokens: 1500000 };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            item={largeTokenItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
          />
        </tbody>
      </table>
    );

    expect(screen.getByText('1.5M')).toBeInTheDocument();
  });

  it('formats file sizes in KB correctly', () => {
    const largeFileItem = { ...mockItem, size: 10240 };

    render(
      <table>
        <tbody>
          <PreviewTableRow
            item={largeFileItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
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
        <tbody
          onClick={rowClickHandler}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') rowClickHandler();
          }}
        >
          <PreviewTableRow
            item={mockItem}
            isSelected={false}
            onToggleSelection={mockOnToggleSelection}
            onFileClick={mockOnFileClick}
            columnVisibility={defaultColumnVisibility}
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
});
