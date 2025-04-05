import { screen } from '@testing-library/react';
import { PreviewPanel } from '../../preview-panel';
import { createCompositeKey, defaultProps, render, userEvent } from './preview-panel-test-utils';

describe('PreviewPanel - Initial State and Empty States', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should show "No files selected" when no files are selected', () => {
    render(<PreviewPanel {...defaultProps} />);
    expect(screen.getByText('No files selected')).toBeInTheDocument();
  });

  it('should handle empty selectedFiles', () => {
    render(<PreviewPanel {...defaultProps} selectedFiles={new Set()} />);
    expect(screen.getByText('No files selected')).toBeInTheDocument();
  });

  it('should handle empty fileContents', () => {
    const selectedFile = createCompositeKey('file1.txt');
    render(
      <PreviewPanel {...defaultProps} selectedFiles={new Set([selectedFile])} fileContents={{}} />
    );
    expect(screen.getByText(/file1\.txt/i)).toBeInTheDocument();
  });
});
