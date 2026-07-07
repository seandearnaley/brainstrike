import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolderHeaderRow } from '../folder-header-row';

describe('FolderHeaderRow', () => {
  it('renders folder info and triggers collapse toggle', async () => {
    const onToggle = vi.fn();
    render(
      <FolderHeaderRow
        isCollapsed={false}
        item={{ fileCount: 3, folderId: 'folderA', totalTokens: 100 }}
        onToggleCollapse={onToggle}
      />
    );
    expect(screen.getByText('folderA')).toBeInTheDocument();
    expect(screen.getByText('3 files')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalled();
  });
});
