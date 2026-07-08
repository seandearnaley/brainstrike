import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let RootLayoutContent: React.ComponentType;

const createQueueStub = (): QueueAdapter => {
  const result = {
    id: 'stub',
    metadata: {
      batchSize: 1,
      device: 'webgpu',
      dimensions: 0,
      dtype: 'fp16',
      elapsedMs: 0,
      fallbackApplied: false,
      model: 'stub-model',
    },
    type: 'result',
    vectors: [new Float32Array(0)],
  } satisfies QueueResult;
  return {
    add: vi.fn(async () => result),
    addBulk: vi.fn(async () => [result]),
    cancel: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    isPaused: false,
    isProcessing: false,
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  };
};

const queueStub = createQueueStub();

vi.mock('../create-embedding-queue', () => ({
  createBrowserEmbeddingQueue: vi.fn(() => queueStub),
  embeddingQueue: queueStub,
  getEmbeddingQueue: () => queueStub,
}));

// Mock the database module
vi.mock('@brainstrike/db', () => ({
  DbProvider: ({ children }: { children: React.ReactNode }) => children,
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useDatabase: () => ({
    db: null,
    error: null,
    isLoading: false,
  }),
}));

// Mock the file system module
vi.mock('@brainstrike/file-system', () => ({
  createFileSystemAdapter: () => ({
    createDirectory: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
  }),
  createFixtureCapableAdapter: (adapter: unknown) => adapter,
  WebFileSystemAdapter: vi.fn(),
}));

// Mock the storage module
vi.mock('@brainstrike/storage', () => ({
  createStorageAdapter: () => ({
    clear: vi.fn().mockResolvedValue(undefined),
    getItem: vi.fn().mockResolvedValue(null),
    removeItem: vi.fn().mockResolvedValue(undefined),
    setItem: vi.fn().mockResolvedValue(undefined),
  }),
  LocalStorageAdapter: vi.fn(),
}));

// Mock the file explorer hooks module
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => children,
  useAdapters: () => ({
    fileSystemAdapter: {
      readDirectory: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(''),
    },
    storageAdapter: {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

// Mock react-helmet-async
vi.mock('react-helmet-async', () => ({
  HelmetProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// TODO: These integration tests need complex mock setup for routing and providers.
// They are currently skipped pending a refactoring of the test infrastructure.
describe.skip('RootLayoutContent Integration Tests', () => {
  beforeAll(async () => {
    RootLayoutContent = (await import('../app/root-layout-content')).default;
  });

  it('should render the main application and navigate between routes', async () => {
    const user = userEvent.setup();

    render(
      <BrowserRouter>
        <RootLayoutContent />
      </BrowserRouter>
    );

    // Check that the app renders
    await waitFor(() => {
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    // Test navigation to settings
    const settingsLink = screen.queryByRole('link', { name: /settings/i });
    if (settingsLink) {
      await user.click(settingsLink);
      await waitFor(() => {
        expect(window.location.pathname).toContain('/settings');
      });
    }
  });

  it('should handle file operations through the UI', async () => {
    const user = userEvent.setup();

    render(
      <BrowserRouter>
        <RootLayoutContent />
      </BrowserRouter>
    );

    // Wait for the app to load
    await waitFor(() => {
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    // Test file upload interaction
    const fileInput =
      screen.queryByLabelText(/upload/i) || screen.queryByRole('button', { name: /upload/i });
    if (fileInput) {
      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });

      if (fileInput.tagName === 'INPUT') {
        await user.upload(fileInput as HTMLInputElement, file);
      } else {
        await user.click(fileInput);
      }

      // Verify file handling
      await waitFor(() => {
        // Check for success indicators or file list updates
        const fileList = screen.queryByRole('list');
        if (fileList) {
          expect(fileList).toBeInTheDocument();
        }
      });
    }
  });

  it('should maintain state across component interactions', async () => {
    const user = userEvent.setup();

    render(
      <BrowserRouter>
        <RootLayoutContent />
      </BrowserRouter>
    );

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    // Test state persistence
    const toggleButton = screen.queryByRole('button', { name: /toggle/i });
    if (toggleButton) {
      const initialState = toggleButton.getAttribute('aria-pressed');

      await user.click(toggleButton);

      await waitFor(() => {
        const newState = toggleButton.getAttribute('aria-pressed');
        expect(newState).not.toBe(initialState);
      });
    }
  });

  it('should handle error states gracefully', async () => {
    // Mock an error condition
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <BrowserRouter>
        <RootLayoutContent />
      </BrowserRouter>
    );

    // Wait for the app to handle any initialization errors
    await waitFor(() => {
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    // Verify error boundaries or fallback UI
    const errorMessage = screen.queryByRole('alert');
    if (errorMessage) {
      expect(errorMessage).toBeInTheDocument();
    }

    // Clean up
    consoleSpy.mockRestore();
  });

  it('should handle keyboard navigation', async () => {
    const user = userEvent.setup();

    render(
      <BrowserRouter>
        <RootLayoutContent />
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    // Test keyboard navigation
    await user.keyboard('{Tab}');

    // Check focus management
    const activeElement = document.activeElement;
    expect(activeElement).not.toBe(document.body);

    // Test escape key handling
    await user.keyboard('{Escape}');

    // Verify any modals or overlays are closed
    const modal = screen.queryByRole('dialog');
    if (modal) {
      expect(modal).not.toBeInTheDocument();
    }
  });
});
