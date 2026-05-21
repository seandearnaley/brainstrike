import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileContentProvider, useFileContentContext } from '../shell/file-content-context';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

vi.mock('../use-shared-file-content-loading', () => ({
  useSharedFileContentLoading: vi.fn(),
}));

const mockData = {
  fileContents: { key: 'value' },
  isLoading: false,
  error: null,
  handleFileContentLoading: vi.fn(),
  loadingFiles: new Set<string>(),
};

describe('FileContentContext', () => {
  it('throws when used outside the provider', () => {
    expect(() => renderHook(() => useFileContentContext())).toThrow(
      'useFileContentContext must be used within a FileContentProvider'
    );
  });

  it('provides values from useSharedFileContentLoading', () => {
    vi.mocked(useSharedFileContentLoading).mockReturnValue(
      mockData as unknown as ReturnType<typeof useSharedFileContentLoading>
    );

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <FileContentProvider fileTree={[]}>{children}</FileContentProvider>
    );

    const { result } = renderHook(() => useFileContentContext(), { wrapper });

    expect(result.current).toStrictEqual({
      fileContents: mockData.fileContents,
      isLoading: mockData.isLoading,
      error: mockData.error,
      handleFileContentLoading: mockData.handleFileContentLoading,
    });
  });
});
