import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileRow } from '../file-row';

describe('FileRow', () => {
  const baseItem = { compositeKey: 'f:a.txt', folderId: 'f', path: 'a.txt', size: 10, tokens: 5 };

  it('renders file info and handles selection and removal', async () => {
    const onToggle = vi.fn();
    const onRemove = vi.fn();
    const onDetail = vi.fn();
    render(
      <FileRow
        item={baseItem}
        isSelected={false}
        isLoading={false}
        onToggleSelection={onToggle}
        onRemove={onRemove}
        onShowDetail={onDetail}
        formatFileSize={(n) => String(n)}
      />
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalled();
    await user.click(screen.getByTitle('Remove from selection'));
    expect(onRemove).toHaveBeenCalled();
    await user.click(screen.getByText('a.txt'));
    expect(onDetail).toHaveBeenCalled();
  });

  it('shows loading spinner when isLoading', () => {
    render(
      <FileRow
        item={baseItem}
        isSelected={false}
        isLoading={true}
        onToggleSelection={() => {}}
        onRemove={() => {}}
        onShowDetail={() => {}}
        formatFileSize={() => '10'}
      />
    );
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });
});
