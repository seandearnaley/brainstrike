import { describe, expect, it } from 'vitest';
import {
  describeMcpToolsAvailability,
  resolveMcpToolsAvailability,
} from '../mcp-tools-availability';
import type { McpServerInfo } from '../types';

function connected(catalog?: unknown): McpServerInfo {
  return {
    configuredProtocol: 'legacy',
    configuredServerId: 'alpha',
    generation: 1,
    negotiated: { era: '2026-07-28', revision: 1 },
    state: 'connected',
    transport: 'stdio',
    ...(catalog === undefined ? {} : { catalog }),
  } as unknown as McpServerInfo;
}

function catalog(over: Record<string, unknown> = {}): unknown {
  return {
    errors: {},
    features: { tools: true },
    subscription: { state: 'unsupported' },
    tools: { tools: [] },
    ...over,
  };
}

describe('resolveMcpToolsAvailability', () => {
  it('reports available when the tool list loaded', () => {
    expect(resolveMcpToolsAvailability(connected(catalog()))).toBe('available');
  });

  it('reports catalog-unavailable for a connected server with no catalog', () => {
    // The exact case BST-1603 names: the row says Connected, and nothing at all
    // is known about the toolset.
    expect(resolveMcpToolsAvailability(connected())).toBe('catalog-unavailable');
  });

  it('reports tools-unavailable when the tools section errored', () => {
    expect(
      resolveMcpToolsAvailability(
        connected(catalog({ errors: { tools: { code: 'boom', message: 'Connection closed' } } }))
      )
    ).toBe('tools-unavailable');
  });

  it('reports tools-unavailable when the tools section is simply absent', () => {
    expect(resolveMcpToolsAvailability(connected(catalog({ tools: undefined })))).toBe(
      'tools-unavailable'
    );
  });

  it('does NOT flag a server that advertises no tools capability', () => {
    // A prompts-only or resources-only server is healthy. Flagging it would
    // make the new indicator noise and train users to ignore it.
    expect(
      resolveMcpToolsAvailability(
        connected(catalog({ features: { tools: false }, tools: undefined }))
      )
    ).toBe('available');
  });

  it('leaves non-connected states alone', () => {
    // Only `connected` can mislead; error and pending states already render
    // honestly through their own indicator.
    const erroring = {
      configuredProtocol: 'legacy',
      configuredServerId: 'alpha',
      error: { code: 'x', message: 'nope' },
      generation: 1,
      state: 'error',
      transport: 'stdio',
    } as unknown as McpServerInfo;

    expect(resolveMcpToolsAvailability(erroring)).toBe('available');
  });
});

describe('describeMcpToolsAvailability', () => {
  it('says nothing when tools are available', () => {
    expect(describeMcpToolsAvailability('available')).toBeUndefined();
  });

  it('labels the two degraded cases distinctly', () => {
    expect(describeMcpToolsAvailability('catalog-unavailable')).toBe('catalog unavailable');
    expect(describeMcpToolsAvailability('tools-unavailable')).toBe('tools unavailable');
  });
});
