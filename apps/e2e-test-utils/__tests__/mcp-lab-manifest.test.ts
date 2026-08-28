import { describe, expect, it } from 'vitest';
import { getMcpLabScenario, MCP_LAB_SCENARIO_IDS } from '../mcp-lab-manifest';

describe('MCP lab scenario manifest', () => {
  it('pins the official modern reference scenario to the 2026 protocol era', () => {
    expect(getMcpLabScenario('modern-reference')).toEqual({
      authentication: 'none',
      description: 'Pinned official TypeScript SDK v2 modern reference server',
      expectedProtocolVersion: '2026-07-28',
      id: 'modern-reference',
      network: 'loopback-only',
      server: 'official-typescript-sdk-v2-everything',
      transport: 'streamable-http',
      usesAmbientCredentials: false,
    });
  });

  it('publishes unique scenario ids in deterministic order', () => {
    expect(MCP_LAB_SCENARIO_IDS).toEqual([
      'modern-reference',
      'legacy-reference',
      'stdio-reference',
      'oauth-reference',
    ]);
    expect(new Set(MCP_LAB_SCENARIO_IDS).size).toBe(MCP_LAB_SCENARIO_IDS.length);
  });

  it('rejects an unknown scenario instead of selecting a default', () => {
    expect(() => getMcpLabScenario('missing')).toThrow('Unknown MCP lab scenario: missing');
  });
});
