import { afterEach, describe, expect, it } from 'vitest';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';

type CapabilityWindow = Window & { agentHost?: unknown };

afterEach(() => {
  Reflect.deleteProperty(window, 'agentHost');
});

describe('hasDurableAssistantUsageCapability', () => {
  it('is false on a web window, which has no agent host bridge', () => {
    expect(hasDurableAssistantUsageCapability()).toBe(false);
  });

  it('is true when the agent host bridge is present', () => {
    (window as CapabilityWindow).agentHost = { connect: async () => undefined };
    expect(hasDurableAssistantUsageCapability()).toBe(true);
  });
});
