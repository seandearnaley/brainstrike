import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerMiddlePanel } from '../file-explorer-middle-panel';
import { FileExplorerTestWrapper } from './test-helpers';

vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();
  return {
    ...actual,
    FileExplorerHeader: () => <div data-testid="header">Header</div>,
    PreviewPanel: () => <div data-testid="preview">Preview</div>,
    FileExplorerErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../unified-file-explorer-context', () => ({
  useUnifiedFileExplorer: vi.fn(),
}));
vi.mock('../use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(),
}));
vi.mock('@brainstrike/hooks', () => ({
  useUndoableAction: vi.fn(() => ({ performUndoableAction: vi.fn() })),
}));

import { useUnifiedFileExplorer } from '../unified-file-explorer-context';
import { useSelectionManager } from '../use-selection-manager-context';

describe('FileExplorerMiddlePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useUnifiedFileExplorer).mockReturnValue({
      fileContents: {},
      loadingFiles: new Set<string>(),
      rootDirectoryHandle: { name: 'root', kind: 'directory' } as FileSystemDirectoryHandle,
    } as any);

    vi.mocked(useSelectionManager).mockReturnValue({
      selectedFilePaths: new Set<string>(),
      handleSelectionChange: vi.fn(),
    } as any);
  });

  it('renders header and preview panel', async () => {
    render(<FileExplorerMiddlePanel />, { wrapper: FileExplorerTestWrapper });

    expect(await screen.findByTestId('header')).toBeInTheDocument();
    expect(await screen.findByTestId('preview')).toBeInTheDocument();
  });
});
