declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface Window {
    __openFileInTab?: ((compositeKey: string) => void) | undefined;
  }
}

export {};
