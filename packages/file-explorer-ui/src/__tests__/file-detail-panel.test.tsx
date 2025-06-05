import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileDetailPanel } from '../file-detail-panel';

const decode = (key: string) => {
  const [folderId = '', path = ''] = key.split(':');
  return { folderId, path };
};

describe('FileDetailPanel', () => {
  it('renders content and handles close', async () => {
    const onClose = vi.fn();
    render(
      <FileDetailPanel
        compositeKey="f:a.txt"
        fileContents={{ 'f:a.txt': 'hello' }}
        loadingFiles={new Set()}
        onClose={onClose}
        decodeFileSelection={decode}
      />
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows loading state', () => {
    render(
      <FileDetailPanel
        compositeKey="f:a.txt"
        fileContents={{}}
        loadingFiles={new Set(['f:a.txt'])}
        onClose={() => {}}
        decodeFileSelection={decode}
      />
    );
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
