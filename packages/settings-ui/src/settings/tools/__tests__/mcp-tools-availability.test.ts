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

  it('reports available when the tool list loaded', () => {
    expect(resolveMcpToolsAvailability(connected({ catalog: catalog() }))).toBe('available');
  });

  it('does NOT flag a connected server whose catalog has not arrived yet', () => {
    // The regression this function was rewritten for (PR #2945 review).
    // `McpServerActor` publishes `connected` as soon as the handshake completes
    // and fills the catalog in later via `watchCatalog`, so "no catalog" is the
    // normal state of EVERY healthy server on EVERY launch. Flagging it would
    // flash yellow on servers that are enumerating fine.
    expect(resolveMcpToolsAvailability(connected())).toBe('available');
  });

  it('does NOT flag a tools-capable server whose tools section is merely absent', () => {
    // Same reason: absence is indistinguishable from in-flight. Only an ERROR
    // proves the query settled.
    expect(resolveMcpToolsAvailability(connected({ catalog: catalog({ tools: undefined }) }))).toBe(
      'available'
    );
  });

  it('does NOT flag a server that advertises no tools capability', () => {
    // A prompts-only or resources-only server is healthy.
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
    ).toBe('available');
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

  it('labels the degraded case', () => {
    expect(describeMcpToolsAvailability('tools-unavailable')).toBe('tools unavailable');
  });
});
