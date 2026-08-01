import { describe, expect, it } from 'vitest';

const consoleErrorAtTestDefinition = console.error;

describe('app-shell Vitest setup observability', () => {
  it('leaves console.error intact so React synchronization warnings are visible', () => {
    expect(console.error).toBe(consoleErrorAtTestDefinition);
  });
});
