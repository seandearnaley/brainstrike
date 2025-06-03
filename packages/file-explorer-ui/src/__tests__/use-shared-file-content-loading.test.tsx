import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import { useSharedFileContentLoading, FileContentAdapter } from '../use-shared-file-content-loading';

const mockFileContentAdapter: FileContentAdapter = {
  getFileContent: vi.fn(),
};

const mockOnFileLoaded = vi.fn();

const DEFAULT_MAX_CACHE_SIZE = 1024 * 1024; // 1MB default in hook

describe('useSharedFileContentLoading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset adapter mocks for each test
    mockFileContentAdapter.getFileContent = vi.fn();
  });

  const getHook = (props: Partial<Parameters<typeof useSharedFileContentLoading>[0]> = {}) => {
    const { result } = renderHook(() =>
      useSharedFileContentLoading({
        fileContentAdapter: mockFileContentAdapter,
        onFileLoaded: mockOnFileLoaded,
        maxCacheSize: DEFAULT_MAX_CACHE_SIZE,
        ...props,
      })
    );
    return result;
  };

  describe('Hook Initialization and Initial State', () => {
    it('should initialize with empty fileContents, loadingFiles, failedFiles, and zero cacheSize', () => {
      const result = getHook();
      expect(result.current.fileContents).toEqual({});
      expect(result.current.loadingFiles).toEqual(new Set());
      expect(result.current.failedFiles).toEqual(new Set());
      expect(result.current.cacheSize).toBe(0);
    });
  });

  describe('loadFileContent Function', () => {
    it('successful file load: updates states correctly and calls onFileLoaded', async () => {
      const filePath = 'test.txt';
      const fileContent = 'This is a test file.';
      mockFileContentAdapter.getFileContent.mockResolvedValue(fileContent);
      
      const result = getHook();

      // Initial call
      await act(async () => {
        result.current.loadFileContent(filePath);
      });
      
      // Check loading state during call (might be too fast to catch, but let's try)
      // This depends on how act and promises are handled. In many cases, it might already be resolved.
      // For more precise check of intermediate loading state, need to delay the promise.

      expect(mockFileContentAdapter.getFileContent).toHaveBeenCalledWith(filePath);
      expect(result.current.loadingFiles).not.toContain(filePath); // Should be removed after load
      expect(result.current.fileContents[filePath]).toBe(fileContent);
      expect(result.current.failedFiles).not.toContain(filePath);
      expect(mockOnFileLoaded).toHaveBeenCalledWith({ path: filePath, content: fileContent, success: true });
      expect(result.current.cacheSize).toBe(fileContent.length);
    });

    it('file load error: updates states correctly and calls onFileLoaded with error', async () => {
      const filePath = 'error.txt';
      const errorMessage = 'Error loading file: error.txt';
      mockFileContentAdapter.getFileContent.mockRejectedValue(new Error('Network Error'));
      
      const result = getHook();

      await act(async () => {
        result.current.loadFileContent(filePath);
      });

      expect(result.current.loadingFiles).not.toContain(filePath);
      expect(result.current.fileContents[filePath]).toBe(errorMessage);
      expect(result.current.failedFiles).toContain(filePath);
      expect(mockOnFileLoaded).toHaveBeenCalledWith({ path: filePath, content: errorMessage, success: false });
      expect(result.current.cacheSize).toBe(errorMessage.length); // Error message also consumes cache
    });

    it('loading already cached file: uses cache and calls onFileLoaded, no new fetch', async () => {
      const filePath = 'cached.txt';
      const fileContent = 'Cached content.';
      mockFileContentAdapter.getFileContent.mockResolvedValueOnce(fileContent); // For first load

      const result = getHook();

      // First load
      await act(async () => {
        result.current.loadFileContent(filePath);
      });
      expect(result.current.fileContents[filePath]).toBe(fileContent);
      expect(mockOnFileLoaded).toHaveBeenCalledTimes(1);
      mockOnFileLoaded.mockClear(); // Clear for next assertion

      // Second load for the same file
      await act(async () => {
        result.current.loadFileContent(filePath);
      });
      
      expect(mockFileContentAdapter.getFileContent).toHaveBeenCalledTimes(1); // Not called again
      expect(result.current.fileContents[filePath]).toBe(fileContent); // Still cached
      expect(mockOnFileLoaded).toHaveBeenCalledWith({ path: filePath, content: fileContent, success: true });
      expect(result.current.loadingFiles).not.toContain(filePath);
    });

    it('loading an already loading file (concurrent): fetches only once', async () => {
      const filePath = 'concurrent.txt';
      const fileContent = 'Concurrent content here.';
      let resolvePromise: (value: string) => void;
      const promise = new Promise<string>((resolve) => {
        resolvePromise = resolve;
      });
      mockFileContentAdapter.getFileContent.mockReturnValue(promise);

      const result = getHook();

      // First call, promise is pending
      act(() => {
        result.current.loadFileContent(filePath);
      });
      expect(result.current.loadingFiles).toContain(filePath);
      expect(mockFileContentAdapter.getFileContent).toHaveBeenCalledTimes(1);
      
      // Second call for the same file while first is still loading
      act(() => {
        result.current.loadFileContent(filePath);
      });
      expect(result.current.loadingFiles).toContain(filePath); // Still loading
      expect(mockFileContentAdapter.getFileContent).toHaveBeenCalledTimes(1); // Adapter not called again

      // Resolve the original promise
      await act(async () => {
        resolvePromise(fileContent);
        await promise; // Ensure promise resolution is processed by act
      });
      
      expect(result.current.loadingFiles).not.toContain(filePath);
      expect(result.current.fileContents[filePath]).toBe(fileContent);
      // onFileLoaded should be called for both logical requests,
      // or at least the state should reflect the loaded content for any listener.
      // The hook itself calls onFileLoaded once per successful fetch completion.
      // If multiple "waiters" exist for the same promise, they all get the result.
      // The onFileLoaded callback is tied to the hook's instance, not per-call to loadFileContent.
      // So it should be called once when the file is actually loaded.
      // However, the test plan implies onFileLoaded might be called for both "callers".
      // The current hook implementation will call onFileLoaded once the actual fetch completes.
      expect(mockOnFileLoaded).toHaveBeenCalledTimes(1); 
      expect(mockOnFileLoaded).toHaveBeenCalledWith({ path: filePath, content: fileContent, success: true });
    });

    it('file marked as binary by adapter: stores "Binary file" message', async () => {
      const filePath = 'binary.bin';
      const binaryContentSignal = 'Binary file: binary.bin'; // Hook generates this exact message
      // Simulate adapter returning content that the hook interprets as binary.
      // The hook itself checks for `content.startsWith('Binary file')` from the adapter,
      // or if the adapter itself returns a specific error/signal.
      // For this test, let's assume the adapter returns a string that starts with "Binary file:"
      mockFileContentAdapter.getFileContent.mockResolvedValue('Binary file: binary.bin'); // Adapter signals binary

      const result = getHook();
      await act(async () => {
        result.current.loadFileContent(filePath);
      });

      expect(result.current.fileContents[filePath]).toBe(binaryContentSignal);
      expect(result.current.failedFiles).toContain(filePath);
      expect(mockOnFileLoaded).toHaveBeenCalledWith({ path: filePath, content: binaryContentSignal, success: false });
    });
  });

  describe('Cache Management', () => {
    it('maxCacheSize enforcement (LRU-like eviction): evicts least recently accessed', async () => {
      const smallCacheSize = 25; // Enough for two small files, but not three
      const result = getHook({ maxCacheSize: smallCacheSize });

      const file1 = 'file1.txt'; const content1 = 'content_1'; // 9 bytes
      const file2 = 'file2.txt'; const content2 = 'content_22'; // 10 bytes
      const file3 = 'file3.txt'; const content3 = 'content_333'; // 11 bytes
      // Total: 9 + 10 + 11 = 30 bytes. Max: 25.

      mockFileContentAdapter.getFileContent
        .mockResolvedValueOnce(content1)
        .mockResolvedValueOnce(content2)
        .mockResolvedValueOnce(content3);

      // Load file1 (cache: 9)
      await act(async () => { result.current.loadFileContent(file1); });
      expect(result.current.fileContents[file1]).toBe(content1);
      expect(result.current.cacheSize).toBe(content1.length);

      // Load file2 (cache: 9 + 10 = 19)
      await act(async () => { result.current.loadFileContent(file2); });
      expect(result.current.fileContents[file2]).toBe(content2);
      expect(result.current.cacheSize).toBe(content1.length + content2.length);
      
      // Access file1 again to make it most recently used before adding file3
      await act(async () => { result.current.loadFileContent(file1); });
      expect(mockFileContentAdapter.getFileContent).toHaveBeenCalledTimes(2); // No new fetch for file1

      // Load file3 (cache: 19 + 11 = 30, exceeds 25. file2 should be evicted as it's now LRU)
      await act(async () => { result.current.loadFileContent(file3); });
      expect(result.current.fileContents[file3]).toBe(content3);
      expect(result.current.fileContents[file1]).toBe(content1); // file1 should still be there
      expect(result.current.fileContents[file2]).toBeUndefined(); // file2 should be evicted
      expect(result.current.cacheSize).toBe(content1.length + content3.length); // 9 + 11 = 20
      
      // Request evicted file2 again, should be refetched
      mockFileContentAdapter.getFileContent.mockResolvedValueOnce(content2);
      await act(async () => { result.current.loadFileContent(file2); });
      expect(mockFileContentAdapter.getFileContent).toHaveBeenCalledTimes(4); // file1, file2, file3, then file2 again
      expect(result.current.fileContents[file2]).toBe(content2);
      // Eviction due to file2: file3 should be LRU now (file1 was accessed before file3's initial load, file2 is newest)
      // Order of access for cache: file1, file2, file1, file3, file2
      // Cache before file2 re-load: {file1: content1 (9), file3: content3 (11)} -> size 20
      // Adding file2 (10): 20 + 10 = 30. Max 25. file3 should be evicted.
      expect(result.current.fileContents[file1]).toBe(content1);
      expect(result.current.fileContents[file3]).toBeUndefined();
      expect(result.current.cacheSize).toBe(content1.length + content2.length); // 9 + 10 = 19
    });

    it('clearCache function: resets all relevant states', async () => {
      const result = getHook();
      const file1 = 'file1.txt'; const content1 = 'content_1';
      const fileError = 'error.txt'; const errorMsg = 'Error loading file: error.txt';

      mockFileContentAdapter.getFileContent.mockResolvedValueOnce(content1);
      mockFileContentAdapter.getFileContent.mockRejectedValueOnce(new Error('failed'));

      await act(async () => { result.current.loadFileContent(file1); });
      await act(async () => { result.current.loadFileContent(fileError); });
      
      // Start a file loading but don't resolve it
      let resolveLoading;
      const loadingPromise = new Promise(resolve => { resolveLoading = resolve; });
      mockFileContentAdapter.getFileContent.mockReturnValueOnce(loadingPromise);
      act(() => { result.current.loadFileContent('loading.txt'); });


      expect(Object.keys(result.current.fileContents).length).toBeGreaterThan(0);
      expect(result.current.failedFiles.size).toBeGreaterThan(0);
      expect(result.current.loadingFiles.size).toBeGreaterThan(0);
      expect(result.current.cacheSize).toBeGreaterThan(0);

      act(() => {
        result.current.clearCache();
      });

      expect(result.current.fileContents).toEqual({});
      expect(result.current.loadingFiles).toEqual(new Set()); // Should clear loading files too
      expect(result.current.failedFiles).toEqual(new Set());
      expect(result.current.cacheSize).toBe(0);
      
      // Resolve the pending promise to ensure no side-effects after cache clear
      await act(async () => {
        resolveLoading?.('belated content');
        await loadingPromise.catch(() => {}); // Catch if it was somehow rejected by cancellation
      });
       expect(result.current.fileContents).toEqual({}); // Still empty
    });

    it('invalidateCacheEntry function: removes entry and updates cacheSize', async () => {
      const result = getHook();
      const file1 = 'file1.txt'; const content1 = 'content_1'; // 9 bytes
      const file2 = 'file2.txt'; const content2 = 'content_22'; // 10 bytes

      mockFileContentAdapter.getFileContent
        .mockResolvedValueOnce(content1)
        .mockResolvedValueOnce(content2);

      await act(async () => { result.current.loadFileContent(file1); });
      await act(async () => { result.current.loadFileContent(file2); });
      
      expect(result.current.fileContents[file1]).toBe(content1);
      expect(result.current.cacheSize).toBe(content1.length + content2.length);

      act(() => {
        result.current.invalidateCacheEntry(file1);
      });

      expect(result.current.fileContents[file1]).toBeUndefined();
      expect(result.current.failedFiles).not.toContain(file1); // Should also remove from failed if it was there
      expect(result.current.cacheSize).toBe(content2.length);

      // Invalidate a non-existent entry, should not error
      act(() => {
        result.current.invalidateCacheEntry('nonexistent.txt');
      });
      expect(result.current.cacheSize).toBe(content2.length);
    });
    
    it('invalidateCacheEntry function: removes entry from loadingFiles if it was loading', async () => {
      const result = getHook();
      const filePath = 'loadingFile.txt';
      let resolvePromise;
      const promise = new Promise(resolve => { resolvePromise = resolve; });
      mockFileContentAdapter.getFileContent.mockReturnValueOnce(promise);

      // Start loading
      act(() => { result.current.loadFileContent(filePath); });
      expect(result.current.loadingFiles).toContain(filePath);

      // Invalidate while loading
      act(() => { result.current.invalidateCacheEntry(filePath); });
      
      expect(result.current.loadingFiles).not.toContain(filePath);
      
      // Resolve the promise - should not update cache or call onFileLoaded if invalidated effectively cancels it
      mockOnFileLoaded.mockClear();
      await act(async () => { 
        resolvePromise('some content');
        try { await promise; } catch (e) { /* ignore if promise was cancelled */ }
      });
      
      expect(result.current.fileContents[filePath]).toBeUndefined();
      expect(mockOnFileLoaded).not.toHaveBeenCalled();
    });
  });

  describe('Dependencies', () => {
    it('uses fileContentAdapter from props', async () => {
        const customAdapter = { getFileContent: vi.fn().mockResolvedValue('custom content') };
        const result = getHook({ fileContentAdapter: customAdapter });
        await act(async () => { result.current.loadFileContent('test.txt'); });
        expect(customAdapter.getFileContent).toHaveBeenCalledWith('test.txt');
    });

    it('calls onFileLoaded from props', async () => {
        const customOnFileLoaded = vi.fn();
        mockFileContentAdapter.getFileContent.mockResolvedValue('content');
        const result = getHook({ onFileLoaded: customOnFileLoaded });
        await act(async () => { result.current.loadFileContent('test.txt'); });
        expect(customOnFileLoaded).toHaveBeenCalledWith({ path: 'test.txt', content: 'content', success: true });
    });

    it('respects maxCacheSize from props for eviction', async () => {
        const maxCacheSize = 15; // smaller than default
        const result = getHook({ maxCacheSize });

        const file1 = 'f1.txt'; const c1 = 'content1'; // 8
        const file2 = 'f2.txt'; const c2 = 'content2'; // 8
        const file3 = 'f3.txt'; const c3 = 'content3'; // 8
        // Total 24. Max 15.

        mockFileContentAdapter.getFileContent.mockResolvedValueOnce(c1).mockResolvedValueOnce(c2).mockResolvedValueOnce(c3);

        await act(async () => { result.current.loadFileContent(file1); }); // cache: 8
        await act(async () => { result.current.loadFileContent(file2); }); // cache: 16, f1 evicted. cache: {f2: 8}
        
        expect(result.current.fileContents[file1]).toBeUndefined();
        expect(result.current.fileContents[file2]).toBe(c2);
        expect(result.current.cacheSize).toBe(c2.length);

        await act(async () => { result.current.loadFileContent(file3); }); // cache: 8 + 8 = 16. f2 evicted. cache: {f3: 8}
        expect(result.current.fileContents[file2]).toBeUndefined();
        expect(result.current.fileContents[file3]).toBe(c3);
        expect(result.current.cacheSize).toBe(c3.length);
    });
  });
});
