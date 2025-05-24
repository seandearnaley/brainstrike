export interface StorageAdapter {
  /**
   * Get a value from storage
   */
  getItem(key: string): Promise<string | null>;

  /**
   * Set a value in storage
   */
  setItem(key: string, value: string): Promise<void>;

  /**
   * Remove a value from storage
   */
  removeItem(key: string): Promise<void>;

  /**
   * Clear all storage
   */
  clear(): Promise<void>;

  /**
   * Get all keys in storage
   */
  getAllKeys(): Promise<string[]>;
}

export interface PersistConfig<TState> {
  name: string;
  version?: number;
  storage: StorageAdapter;
  partialize?: (state: TState) => Partial<TState>;
  onRehydrateStorage?: () => (state?: TState) => void;
}

export type Platform = 'web' | 'electron';
