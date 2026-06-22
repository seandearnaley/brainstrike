import { afterEach, describe, expect, it } from 'vitest';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';

function setAssistant(assistant: unknown): void {
  (window as unknown as { assistant?: unknown }).assistant = assistant;
}

function clearAssistant(): void {
  (window as unknown as { assistant?: unknown }).assistant = undefined;
}

describe('hasDurableAssistantUsageCapability', () => {
  afterEach(clearAssistant);

  it('is false when no assistant bridge exists', () => {
    clearAssistant();
    expect(hasDurableAssistantUsageCapability()).toBe(false);
  });

  it('is true for a non-empty string url', () => {
    setAssistant({ url: 'http://localhost:1234' });
    expect(hasDurableAssistantUsageCapability()).toBe(true);
  });

  it('is true for a callable getUrl', () => {
    setAssistant({ getUrl: () => 'http://localhost:1234' });
    expect(hasDurableAssistantUsageCapability()).toBe(true);
  });

  // The bug: a truthy-but-wrong url passed the old `Boolean(url || getUrl)` probe
  // and then threw downstream when the URL was actually used.
  it('is FALSE for a truthy-but-non-string url (e.g. {})', () => {
    setAssistant({ url: {} });
    expect(hasDurableAssistantUsageCapability()).toBe(false);
  });

  it('is FALSE for an empty-string url', () => {
    setAssistant({ url: '' });
    expect(hasDurableAssistantUsageCapability()).toBe(false);
  });

  it('is FALSE for a non-function getUrl', () => {
    setAssistant({ getUrl: 'not-a-fn' });
    expect(hasDurableAssistantUsageCapability()).toBe(false);
  });
});
