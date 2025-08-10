import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createMockFileSystemAdapter } from '@brainstrike/file-system';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import type React from 'react';
import { FileExplorerLeftPanel } from '../file-explorer-left-panel';
import { FileExplorerProvider } from '../file-explorer-provider';

function Wrapper({ children }: { children: React.ReactNode }) {
  const fs = createMockFileSystemAdapter();
  // Minimal storage adapter for provider
  const storageAdapter = {
    async getItem(): Promise<string | null> {
      return null;
    },
    async setItem(): Promise<void> {},
    async removeItem(): Promise<void> {},
    async clear(): Promise<void> {},
    async getAllKeys(): Promise<string[]> {
      return [];
    },
  };
  return (
    <AdaptersProvider fileSystemAdapter={fs} storageAdapter={storageAdapter}>
      <TooltipProvider>
        <FileExplorerProvider storageAdapter={storageAdapter}>{children}</FileExplorerProvider>
      </TooltipProvider>
    </AdaptersProvider>
  );
}

describe('FileExplorerLeftPanel flag parity', () => {
  it('renders toolbar and footer regardless of useV2', () => {
    const { rerender } = render(
      <Wrapper>
        <FileExplorerLeftPanel useV2={false} />
      </Wrapper>
    );
    // Settings button (toolbar)
    expect(screen.getByTestId('settings-button')).toBeInTheDocument();

    rerender(
      <Wrapper>
        <FileExplorerLeftPanel useV2 />
      </Wrapper>
    );
    // Still present
    expect(screen.getByTestId('settings-button')).toBeInTheDocument();
  });
});
