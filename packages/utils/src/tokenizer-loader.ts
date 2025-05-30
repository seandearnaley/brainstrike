let tokenizerPromise: Promise<typeof import('gpt-tokenizer')> | null = null;

export function getTokenizer(): Promise<typeof import('gpt-tokenizer')> {
  if (!tokenizerPromise) {
    tokenizerPromise = import('gpt-tokenizer').catch((error) => {
      console.warn('Failed to load gpt-tokenizer, will retry on next call', error);
      tokenizerPromise = null;
      throw error;
    });
  }
  return tokenizerPromise;
}

export function __getTokenizerPromise(): Promise<typeof import('gpt-tokenizer')> | null {
  return tokenizerPromise;
}

export function __resetTokenizerPromise(): void {
  tokenizerPromise = null;
}
