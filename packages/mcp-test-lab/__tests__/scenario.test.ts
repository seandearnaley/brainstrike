import { describe, expect, it } from 'vitest';
import {
  getMcpLabScenario,
  MCP_LAB_CONFORMANCE_VERSION,
  MCP_LAB_SCENARIO_IDS,
  MCP_LAB_SDK_SOURCE_SHA,
  MCP_LAB_SDK_VERSION,
} from '../src/scenario';

describe('MCP lab scenario manifest', () => {
  it('identifies the Brainstrike fixture and exact official source pins', () => {
    expect(getMcpLabScenario('modern-reference')).toEqual({
      authentication: 'none',
      description: 'Brainstrike modern reference server built with the pinned official SDK',
      fixture: 'brainstrike-sdk-v2-reference',
      id: 'modern-reference',
      network: 'loopback-only',
      protocol: { era: 'modern', version: '2026-07-28' },
      reference: {
        clientPackage: '@modelcontextprotocol/client',
        conformancePackage: '@modelcontextprotocol/conformance',
        conformanceVersion: MCP_LAB_CONFORMANCE_VERSION,
        sdkSourceSha: MCP_LAB_SDK_SOURCE_SHA,
        sdkVersion: MCP_LAB_SDK_VERSION,
        serverPackage: '@modelcontextprotocol/server',
      },
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
