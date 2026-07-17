export interface StorageAdapter {
  /**
   * Clear all storage
   */
  clear: () => Promise<void>;

  /**
   * Get all keys in storage
   */
  getAllKeys: () => Promise<string[]>;
  /**
   * Get a value from storage
   */
  getItem: (key: string) => Promise<string | null>;

  /**
   * Remove a value from storage
   */
  removeItem: (key: string) => Promise<void>;

  /**
   * Set a value in storage
   */
  setItem: (key: string, value: string) => Promise<void>;
}

export interface PersistConfig<TState> {
  name: string;
  onRehydrateStorage?: () => (state?: TState) => void;
  partialize?: (state: TState) => Partial<TState>;
  storage: StorageAdapter;
  version?: number;
}
