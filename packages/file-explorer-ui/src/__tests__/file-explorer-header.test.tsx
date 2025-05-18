import { FileExplorerStrings } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileExplorerHeader } from '../file-explorer-header';

describe('FileExplorerHeader', () => {
  it('renders title and subtitle', () => {
    render(<FileExplorerHeader />);
    expect(screen.getByRole('heading', { name: FileExplorerStrings.title })).toBeInTheDocument();
    expect(
      screen.getByText('Navigate and select files to include in your project')
    ).toBeInTheDocument();
  });
});
