import { describe, expect, it } from 'vitest';

describe('preload bridge APIs', () => {
  it('exposes window.secrets with expected methods', () => {
    expect(window.secrets).toBeDefined();
    expect(typeof window.secrets.saveKey).toBe('function');
    expect(typeof window.secrets.getKey).toBe('function');
    expect(typeof window.secrets.deleteKey).toBe('function');
    expect(typeof window.secrets.list).toBe('function');
  });

  it('exposes window.agent with chat method', () => {
    expect(window.agent).toBeDefined();
    expect(typeof window.agent.chat).toBe('function');
  });
});
