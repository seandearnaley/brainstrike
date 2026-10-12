import { afterEach, describe, expect, it } from 'vitest';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';

type CapabilityWindow = Window & { agentHost?: unknown; assistant?: unknown };

afterEach(() => {
  Reflect.deleteProperty(window, 'agentHost');
  Reflect.deleteProperty(window, 'assistant');
});

describe('hasDurableAssistantUsageCapability', () => {
  it('is false on a web window, which has no agent host bridge', () => {
    expect(hasDurableAssistantUsageCapability()).toBe(false);
  });

  it('is true when the agent host bridge is present', () => {
    (window as CapabilityWindow).agentHost = { connect: async () => undefined };
    expect(hasDurableAssistantUsageCapability()).toBe(true);
  });

  it('ignores the retired assistant server bridge', () => {
    (window as CapabilityWindow).assistant = { url: 'http://127.0.0.1:4111' };
    expect(hasDurableAssistantUsageCapability()).toBe(false);
  });
});
