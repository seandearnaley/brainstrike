import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileEditorContextValue } from '../contexts/file-editor-context';
import { FileEditorProvider, useFileEditor } from '../contexts/file-editor-context';

describe('FileEditorContext', () => {
  describe('FileEditorProvider', () => {
    it('should render children', () => {
      const mockValue = { openFileInTab: vi.fn() };

      render(
        <FileEditorProvider value={mockValue}>
          <div data-testid="child">Child Content</div>
        </FileEditorProvider>
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.getByText('Child Content')).toBeInTheDocument();
    });

    it('should provide context value to children', () => {
      const mockOpenFileInTab = vi.fn();
      const mockValue = { openFileInTab: mockOpenFileInTab };

      const TestConsumer = () => {
        const { openFileInTab } = useFileEditor();
        return (
          <button onClick={() => openFileInTab('test-key')} type="button">
            Open File
          </button>
        );
      };

      render(
        <FileEditorProvider value={mockValue}>
          <TestConsumer />
        </FileEditorProvider>
      );

      screen.getByRole('button').click();
      expect(mockOpenFileInTab).toHaveBeenCalledWith('test-key');
    });
  });

  describe('useFileEditor', () => {
    it('should throw error when used outside provider', () => {
      const TestComponent = () => {
        useFileEditor();
        return null;
      };

      // Suppress console.error for expected error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => render(<TestComponent />)).toThrow(
        'useFileEditor must be used within a FileEditorProvider'
      );

      consoleSpy.mockRestore();
    });

    it('should return context value when used within provider', () => {
      const mockOpenFileInTab = vi.fn();
      const mockValue = { openFileInTab: mockOpenFileInTab };
      let capturedContext: FileEditorContextValue | null = null;

      const TestConsumer = () => {
        capturedContext = useFileEditor();
        return null;
      };

      render(
        <FileEditorProvider value={mockValue}>
          <TestConsumer />
        </FileEditorProvider>
      );

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.openFileInTab).toBe(mockOpenFileInTab);
    });

    it('should allow opening multiple files', () => {
      const mockOpenFileInTab = vi.fn();
      const mockValue = { openFileInTab: mockOpenFileInTab };

      const TestConsumer = () => {
        const { openFileInTab } = useFileEditor();
        return (
          <div>
            <button onClick={() => openFileInTab('file1.ts')} type="button">
              File 1
            </button>
            <button onClick={() => openFileInTab('file2.tsx')} type="button">
              File 2
            </button>
          </div>
        );
      };

      render(
        <FileEditorProvider value={mockValue}>
          <TestConsumer />
        </FileEditorProvider>
      );

      screen.getByText('File 1').click();
      screen.getByText('File 2').click();

      expect(mockOpenFileInTab).toHaveBeenCalledTimes(2);
      expect(mockOpenFileInTab).toHaveBeenNthCalledWith(1, 'file1.ts');
      expect(mockOpenFileInTab).toHaveBeenNthCalledWith(2, 'file2.tsx');
    });
  });
});
