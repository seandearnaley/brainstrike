import { describe, expect, it } from 'vitest';

describe('preload bridge APIs', () => {
  it('exposes window.secrets with expected methods', () => {
    expect(window.secrets).toBeDefined();
    expect(typeof window.secrets.saveKey).toBe('function');
    expect(typeof window.secrets.getKey).toBe('function');
    expect(typeof window.secrets.deleteKey).toBe('function');
    expect(typeof window.secrets.list).toBe('function');
    expect(typeof window.secrets.listStored).toBe('function');
    expect(typeof window.secrets.clearAll).toBe('function');
  });

  it('exposes window.agent with chat method', () => {
    expect(window.agent).toBeDefined();
    expect(typeof window.agent.chat).toBe('function');
  });

  it('exposes window.llmHost with lifecycle methods', () => {
    expect(window.llmHost).toBeDefined();
    expect(typeof window.llmHost.ensureStarted).toBe('function');
    expect(typeof window.llmHost.getStatus).toBe('function');
    expect(typeof window.llmHost.stop).toBe('function');
    expect(typeof window.llmHost.reset).toBe('function');
    expect(typeof window.llmHost.onProgress).toBe('function');
    expect(typeof window.llmHost.reportProgress).toBe('function');
  });
});
