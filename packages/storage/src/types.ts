/** Main's string key-value store (`ElectronStorageAdapter`). */
export interface StorageAdapter {
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
