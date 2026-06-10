import { describe, expect, it } from 'vitest';
import {
  AgentHubConfigError,
  assertAgentHubConfig,
  DEFAULT_AGENT_HUB_CONFIG,
} from '../agent-hub/agent-hub-config';

const validConfig = {
  authToken: null,
  bindAddress: '127.0.0.1',
  enabled: true,
  maxMessagesPerChannel: 1000,
  port: 4519,
};

describe('assertAgentHubConfig', () => {
  it('accepts a valid loopback config and returns it typed', () => {
    const config = assertAgentHubConfig(validConfig);
    expect(config.port).toBe(4519);
    expect(config.bindAddress).toBe('127.0.0.1');
  });

  it('provides safe defaults', () => {
    expect(DEFAULT_AGENT_HUB_CONFIG).toEqual({
      authToken: null,
      bindAddress: '127.0.0.1',
      enabled: false,
      maxMessagesPerChannel: 1000,
      port: 4519,
    });
    expect(() => assertAgentHubConfig(DEFAULT_AGENT_HUB_CONFIG)).not.toThrow();
  });

  it('accepts port 0 as "assign an ephemeral port"', () => {
    expect(assertAgentHubConfig({ ...validConfig, port: 0 }).port).toBe(0);
  });

  it.each([
    ['port too high', { ...validConfig, port: 70_000 }],
    ['port below 1024', { ...validConfig, port: 80 }],
    ['string port', { ...validConfig, port: '4519' }],
    ['bad bind address', { ...validConfig, bindAddress: 'localhost' }],
    ['blank auth token', { ...validConfig, authToken: '   ' }],
    ['bad max messages', { ...validConfig, maxMessagesPerChannel: 5 }],
    ['non-object', 'nope'],
    ['missing field', { ...validConfig, enabled: undefined }],
  ])('throws AgentHubConfigError for %s', (_label, value) => {
    expect(() => assertAgentHubConfig(value)).toThrow(AgentHubConfigError);
  });

  it('requires an auth token when binding all interfaces', () => {
    expect(() => assertAgentHubConfig({ ...validConfig, bindAddress: '0.0.0.0' })).toThrow(
      /auth token/i
    );
    expect(() =>
      assertAgentHubConfig({ ...validConfig, authToken: 'secret-token', bindAddress: '0.0.0.0' })
    ).not.toThrow();
  });
});
