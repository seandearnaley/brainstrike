import { vi } from 'vitest';
import {
  loadPersistedFileExplorerState,
  persistFileExplorerState,
  clearPersistedFileExplorerState,
  FILE_EXPLORER_STATE_KEY, // Assuming this is exported or replicating its value
} from '../file-explorer-persistence'; // Adjust import path if necessary
import { FileExplorerPersistedState } from '../../types'; // Assuming this type is defined

// Mock localStorage
const localStorageMock = (() => {
  let store: { [key: string]: string } = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      if (typeof value !== 'string') { // localStorage stringifies
        store[key] = JSON.stringify(value);
      } else {
        store[key] = value;
      }
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
    get length() { // Use a getter for length
      return Object.keys(store).length;
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true, // Allow re-mocking if absolutely necessary, though usually not for localStorage
});

const defaultState: FileExplorerPersistedState = {
  expandedFolders: [],
  treeViewWidth: 250,
  // Add other fields that your FileExplorerPersistedState might have
};

describe('File Explorer Persistence', () => {
  beforeEach(() => {
    localStorageMock.clear(); // Clear store
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    localStorageMock.removeItem.mockClear();
  });

  describe('loadPersistedFileExplorerState', () => {
    it('should return null if no data is in localStorage', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const state = loadPersistedFileExplorerState();
      expect(localStorageMock.getItem).toHaveBeenCalledWith(FILE_EXPLORER_STATE_KEY);
      expect(state).toBeNull();
    });

    it('should return parsed state if valid data is in localStorage', () => {
      const persistedData: FileExplorerPersistedState = {
        expandedFolders: ['src', 'src/components'],
        treeViewWidth: 300,
      };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(persistedData));
      const state = loadPersistedFileExplorerState();
      expect(localStorageMock.getItem).toHaveBeenCalledWith(FILE_EXPLORER_STATE_KEY);
      expect(state).toEqual(persistedData);
    });

    it('should return null if JSON parsing fails (malformed JSON)', () => {
      localStorageMock.getItem.mockReturnValue("{malformed_json: 'test'");
      // Suppress console.error for this specific test if the function logs errors
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const state = loadPersistedFileExplorerState();
      
      expect(localStorageMock.getItem).toHaveBeenCalledWith(FILE_EXPLORER_STATE_KEY);
      expect(state).toBeNull(); // Or default state, depending on implementation
      expect(consoleErrorSpy).toHaveBeenCalled(); // Assuming it logs the error
      
      consoleErrorSpy.mockRestore();
    });
    
    it('should handle corrupted data (valid JSON, unexpected structure) by returning it as is or null', () => {
        const corruptedData = { someUnexpectedKey: "someValue" }; // Valid JSON, but not FileExplorerPersistedState
        localStorageMock.getItem.mockReturnValue(JSON.stringify(corruptedData));
        const state = loadPersistedFileExplorerState();
        expect(localStorageMock.getItem).toHaveBeenCalledWith(FILE_EXPLORER_STATE_KEY);
        // Depending on implementation:
        // 1. If it just parses and returns: expect(state).toEqual(corruptedData);
        // 2. If it validates and returns null/default: expect(state).toBeNull(); (More robust)
        // Let's assume it's robust and returns null for unmatchable structures.
        // The current implementation in the codebase likely just returns the parsed object.
        // So, we'll test that behavior. Type casting might hide this in TS but JS will allow it.
        expect(state).toEqual(corruptedData); 
    });
  });

  describe('persistFileExplorerState', () => {
    it('should call localStorage.setItem with stringified state', () => {
      const stateToPersist: FileExplorerPersistedState = {
        expandedFolders: ['src/utils'],
        treeViewWidth: 200,
      };
      persistFileExplorerState(stateToPersist);
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        FILE_EXPLORER_STATE_KEY,
        JSON.stringify(stateToPersist)
      );
    });

    it('should handle JSON.stringify errors gracefully (e.g., circular references)', () => {
      const circularState: any = { name: 'circular' };
      circularState.self = circularState; // Create circular reference

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      persistFileExplorerState(circularState);
      
      // setItem should not be called if stringify fails, or it's called with a fallback.
      // Assuming it catches the error and doesn't call setItem.
      expect(localStorageMock.setItem).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled(); // Assuming it logs the stringify error
      
      consoleErrorSpy.mockRestore();
    });

    it('should handle localStorage.setItem errors gracefully (e.g., quota exceeded)', () => {
      const stateToPersist: FileExplorerPersistedState = defaultState;
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error('QuotaExceededError'); // Simulate quota error
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      persistFileExplorerState(stateToPersist);
      
      expect(localStorageMock.setItem).toHaveBeenCalledWith(FILE_EXPLORER_STATE_KEY, JSON.stringify(stateToPersist));
      expect(consoleErrorSpy).toHaveBeenCalled(); // Assuming it logs the setItem error
      
      consoleErrorSpy.mockRestore();
    });
  });

  describe('clearPersistedFileExplorerState', () => {
    it('should call localStorage.removeItem with the correct key', () => {
      clearPersistedFileExplorerState();
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(FILE_EXPLORER_STATE_KEY);
    });

    it('should handle localStorage.removeItem errors gracefully', () => {
      localStorageMock.removeItem.mockImplementation(() => {
        throw new Error('StorageUnavailable');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      clearPersistedFileExplorerState();
      
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(FILE_EXPLORER_STATE_KEY);
      expect(consoleErrorSpy).toHaveBeenCalled(); // Assuming it logs the removeItem error
      
      consoleErrorSpy.mockRestore();
    });
  });
});
