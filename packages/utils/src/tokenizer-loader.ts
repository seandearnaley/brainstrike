let tokenizerPromise: Promise<typeof import('gpt-tokenizer')> | null = null;

export function getTokenizer(): Promise<typeof import('gpt-tokenizer')> {
  if (!tokenizerPromise) {
    tokenizerPromise = import('gpt-tokenizer');
  }
  return tokenizerPromise;
}

export function __getTokenizerPromise(): Promise<typeof import('gpt-tokenizer')> | null {
  return tokenizerPromise;
}

export function __resetTokenizerPromise(): void {
  tokenizerPromise = null;
}
