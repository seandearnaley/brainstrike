declare global {
  interface Window {
    __openFileInTab?: ((compositeKey: string) => void) | undefined;
  }
}

export {};
