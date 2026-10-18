// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  describeMcpToolsAvailability,
  resolveMcpToolsAvailability,
} from '../mcp-tools-availability';
import type { McpServerInfo } from '../types';

type ConnectedServer = Extract<McpServerInfo, { state: 'connected' }>;
type ServerCatalog = ConnectedServer['catalog'];

/**
 * Typed as the REAL catalog type rather than `unknown` + a double cast (PR
 * #2945 review). `resolveMcpToolsAvailability` dereferences
 * `catalog.errors.tools` without optional chaining on `errors`, and this
 * fixture is the only place that safety claim is exercised — an `unknown`
 * fixture would let the real shape loosen `errors` to optional while every test
 * here kept passing and the row threw on a live server.
 */
function catalog(over: Partial<NonNullable<ServerCatalog>> = {}): ServerCatalog {
  return {
    errors: {},
    features: {
      completion: false,
      promptListChanged: false,
      prompts: false,
      resourceListChanged: false,
      resourceSubscriptions: false,
      resources: false,
      toolListChanged: false,
      tools: true,
    },
    subscription: { state: 'unsupported' },
    tools: { tools: [] },
    ...over,
  } as NonNullable<ServerCatalog>;
}

function connected(over: Partial<ConnectedServer> = {}): McpServerInfo {
  return {
    configuredProtocol: 'legacy',
    configuredServerId: 'alpha',
    generation: 1,
    negotiated: { era: '2026-07-28', revision: 1 },
    state: 'connected',
    transport: 'stdio',
    ...over,
  } as ConnectedServer;
}

describe('resolveMcpToolsAvailability', () => {
  it('reports tools-unavailable ONLY when the tools section errored', () => {
    // A positive, settled failure signal — it cannot be produced by a query
    // that has not finished, which is what makes it safe to report.
    expect(
      resolveMcpToolsAvailability(
        connected({
          catalog: catalog({
            errors: { tools: { category: 'protocol', code: 'boom', message: 'Connection closed' } },
          }),
        })
      )
    ).toBe('tools-unavailable');
  });

  it('reports available when the tool list loaded with tools', () => {
    expect(
      resolveMcpToolsAvailability(
        connected({
          catalog: catalog({
            tools: { tools: [{ inputSchema: { type: 'object' }, name: 'echo' }] },
          }),
        })
      )
    ).toBe('available');
  });

  it('reports empty for a settled list with zero tools (BST-1632)', () => {
    // The host lists before it publishes `connected` and marks every later
    // listing, so a present, empty `tools` is a settled fact, not in-flight.
    expect(resolveMcpToolsAvailability(connected({ catalog: catalog() }))).toBe('empty');
  });

  it('reports loading while the host says tools are listing and none have arrived', () => {
    expect(
      resolveMcpToolsAvailability(
        connected({ catalog: catalog({ listing: ['tools'], tools: undefined }) })
      )
    ).toBe('loading');
  });

  it('reports loading, not the old failure, while a retry after a failed list is in flight', () => {
    // A failure removes the list; a list-changed notification retries it. The
    // failure is the last result, but the retry is what is happening now.
    expect(
      resolveMcpToolsAvailability(
        connected({
          catalog: catalog({
            errors: { tools: { category: 'protocol', code: 'boom', message: 'Connection closed' } },
            listing: ['tools'],
            tools: undefined,
          }),
        })
      )
    ).toBe('loading');
  });

  it('keeps the previous list available while a list-changed refresh is in flight', () => {
    expect(
      resolveMcpToolsAvailability(
        connected({
          catalog: catalog({
            listing: ['tools'],
            tools: { tools: [{ inputSchema: { type: 'object' }, name: 'echo' }] },
          }),
        })
      )
    ).toBe('available');
  });

  it('does NOT read loading from another section listing', () => {
    expect(
      resolveMcpToolsAvailability(
        connected({ catalog: catalog({ listing: ['prompts'], tools: undefined }) })
      )
    ).toBe('available');
  });

  it('claims nothing for a connected server that publishes no catalog', () => {
    // A client without a catalog proves nothing about its tools; flagging it
    // would cry wolf.
    expect(resolveMcpToolsAvailability(connected())).toBe('available');
  });

  it('claims nothing from absence alone: a tools-capable server with no list and no listing', () => {
    expect(resolveMcpToolsAvailability(connected({ catalog: catalog({ tools: undefined }) }))).toBe(
      'available'
    );
  });

  it('reports unsupported for a server that advertises no tools capability', () => {
    // A prompts-only or resources-only server is healthy: it is said plainly,
    // never as a failure.
    expect(
      resolveMcpToolsAvailability(
        connected({
          catalog: catalog({
            features: {
              completion: false,
              promptListChanged: false,
              prompts: true,
              resourceListChanged: false,
              resourceSubscriptions: false,
              resources: false,
              toolListChanged: false,
              tools: false,
            },
            tools: undefined,
          }),
        })
      )
    ).toBe('unsupported');
  });

  it('leaves non-connected states alone', () => {
    const erroring = {
      configuredProtocol: 'legacy',
      configuredServerId: 'alpha',
      error: { category: 'protocol', code: 'x', message: 'nope' },
      generation: 1,
      state: 'error',
      transport: 'stdio',
    } as Extract<McpServerInfo, { state: 'error' }>;

    expect(resolveMcpToolsAvailability(erroring)).toBe('available');
  });
});

describe('describeMcpToolsAvailability', () => {
  it('says nothing when tools are available', () => {
    expect(describeMcpToolsAvailability('available')).toBeUndefined();
  });

  it('labels each state that has something to say', () => {
    expect(describeMcpToolsAvailability('tools-unavailable')).toBe('tools unavailable');
    expect(describeMcpToolsAvailability('loading')).toBe('loading tools');
    expect(describeMcpToolsAvailability('empty')).toBe('no tools');
    expect(describeMcpToolsAvailability('unsupported')).toBe('offers no tools');
  });
});
