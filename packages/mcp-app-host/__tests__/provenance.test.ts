import { describe, expect, it } from 'vitest';
import { McpAppProvenanceAuthority } from '../src/index.js';

describe('MCP Apps same-server provenance', () => {
  it('retains tool metadata and resolves its exact resource only through the owning generation', () => {
    const authority = new McpAppProvenanceAuthority();
    const alpha = authority.openGeneration({ generation: 1, serverId: 'alpha' });
    const beta = authority.openGeneration({ generation: 1, serverId: 'beta' });
    const tool = authority.registerTool(alpha, {
      _meta: {
        ui: {
          resourceUri: 'ui://weather/dashboard',
          visibility: ['model', 'app'],
        },
      },
      name: 'weather',
    });

    expect(authority.toolsFor(alpha, 'model')).toEqual([tool]);
    expect(authority.toolsFor(alpha, 'app')).toEqual([tool]);
    expect(authority.toolsFor(beta, 'app')).toEqual([]);
    expect(tool).toMatchObject({
      generation: 1,
      name: 'weather',
      serverId: 'alpha',
      ui: { resourceUri: 'ui://weather/dashboard', visibility: ['model', 'app'] },
    });

    expect(
      authority.resolveResource(alpha, tool, {
        _meta: { ui: { prefersBorder: true } },
        mimeType: 'text/html;profile=mcp-app',
        text: '<!doctype html><title>Weather</title>',
        uri: 'ui://weather/dashboard',
      })
    ).toEqual({
      generation: 1,
      html: '<!doctype html><title>Weather</title>',
      meta: { prefersBorder: true },
      mimeType: 'text/html;profile=mcp-app',
      serverId: 'alpha',
      source: 'text',
      toolName: 'weather',
      uri: 'ui://weather/dashboard',
    });

    expect(() =>
      authority.resolveResource(beta, tool, {
        mimeType: 'text/html;profile=mcp-app',
        text: '<!doctype html>',
        uri: 'ui://weather/dashboard',
      })
    ).toThrow(/does not belong to server generation/);
  });

  it('binds tool input and result to one audience, server, generation, and request', () => {
    const authority = new McpAppProvenanceAuthority();
    const alpha = authority.openGeneration({ generation: 1, serverId: 'alpha' });
    const beta = authority.openGeneration({ generation: 1, serverId: 'beta' });
    const appOnly = authority.registerTool(alpha, {
      _meta: { ui: { resourceUri: 'ui://shared/app', visibility: ['app'] } },
      name: 'refresh',
    });
    authority.registerTool(beta, {
      _meta: { ui: { resourceUri: 'ui://shared/app', visibility: ['model', 'app'] } },
      name: 'refresh',
    });

    expect(authority.toolsFor(alpha, 'model')).toEqual([]);
    expect(authority.toolsFor(alpha, 'app')).toEqual([appOnly]);
    expect(() =>
      authority.beginToolCall(alpha, appOnly, {
        audience: 'model',
        id: 'model-call',
        input: {},
      })
    ).toThrow(/not visible to model/);
    expect(() =>
      authority.beginToolCall(beta, appOnly, { audience: 'app', id: 'cross-server', input: {} })
    ).toThrow(/does not belong to server generation/);

    const input = { city: 'London' };
    const call = authority.beginToolCall(alpha, appOnly, {
      audience: 'app',
      id: 'call-1',
      input,
    });
    expect(() =>
      authority.beginToolCall(alpha, appOnly, { audience: 'app', id: 'call-1', input: {} })
    ).toThrow(/already pending/);
    input.city = 'Paris';
    expect(call).toMatchObject({
      audience: 'app',
      generation: 1,
      id: 'call-1',
      input: { city: 'London' },
      serverId: 'alpha',
      toolName: 'refresh',
    });
    expect(Object.isFrozen(call.input)).toBe(true);
    expect(() => authority.completeToolCall(beta, call, { content: [] })).toThrow(
      /does not belong to server generation/
    );
    const resultInput = { content: [{ text: 'ok', type: 'text' }] };
    const result = authority.completeToolCall(alpha, call, resultInput);
    resultInput.content[0] = { text: 'mutated', type: 'text' };
    expect(result).toMatchObject({
      generation: 1,
      id: 'call-1',
      result: { content: [{ text: 'ok', type: 'text' }] },
      serverId: 'alpha',
      toolName: 'refresh',
    });
    expect(() => authority.completeToolCall(alpha, call, { content: [] })).toThrow(
      /already settled/
    );
    expect(() =>
      authority.beginToolCall(alpha, appOnly, { audience: 'app', id: 'call-1', input: {} })
    ).not.toThrow();
  });

  it('retires every tool, resource, and call when its server generation advances', () => {
    const authority = new McpAppProvenanceAuthority();
    const first = authority.openGeneration({ generation: 4, serverId: 'alpha' });
    const tool = authority.registerTool(first, {
      _meta: { ui: { resourceUri: 'ui://alpha/app' } },
      name: 'alpha-tool',
    });
    const call = authority.beginToolCall(first, tool, { audience: 'app', id: 1, input: {} });
    authority.openGeneration({ generation: 5, serverId: 'alpha' });

    expect(() => authority.toolsFor(first, 'app')).toThrow(/generation is retired/);
    expect(() =>
      authority.resolveResource(first, tool, {
        mimeType: 'text/html;profile=mcp-app',
        text: '<!doctype html>',
        uri: 'ui://alpha/app',
      })
    ).toThrow(/generation is retired/);
    expect(() => authority.completeToolCall(first, call, {})).toThrow(/generation is retired/);
    expect(() => authority.openGeneration({ generation: 5, serverId: 'alpha' })).toThrow(
      /increase monotonically/
    );
  });

  it('decodes bounded UTF-8 blobs and rejects ambiguous or mismatched resources', () => {
    const authority = new McpAppProvenanceAuthority();
    const generation = authority.openGeneration({ generation: 1, serverId: 'alpha' });
    const tool = authority.registerTool(generation, {
      _meta: { ui: { resourceUri: 'ui://alpha/app' } },
      name: 'alpha-tool',
    });

    expect(
      authority.resolveResource(generation, tool, {
        blob: btoa('<!doctype html><title>Blob</title>'),
        mimeType: 'text/html;profile=mcp-app',
        uri: 'ui://alpha/app',
      })
    ).toMatchObject({ html: '<!doctype html><title>Blob</title>', source: 'blob' });

    // Review of #2916: each rejection names its reason, so a regression in
    // one row cannot hide behind an unrelated throw.
    for (const { reason, resource } of [
      {
        reason: /MIME type/i,
        resource: { mimeType: 'text/html', text: '<!doctype html>', uri: 'ui://alpha/app' },
      },
      {
        reason: /does not match the associated tool resource/,
        resource: {
          mimeType: 'text/html;profile=mcp-app',
          text: '<!doctype html>',
          uri: 'ui://beta/app',
        },
      },
      {
        reason: /bounded canonical base64/,
        resource: { blob: '***', mimeType: 'text/html;profile=mcp-app', uri: 'ui://alpha/app' },
      },
      {
        reason: /non-empty UTF-8/,
        resource: { blob: '/w==', mimeType: 'text/html;profile=mcp-app', uri: 'ui://alpha/app' },
      },
      {
        reason: /exactly one of text or blob/,
        resource: {
          blob: btoa('<!doctype html>'),
          mimeType: 'text/html;profile=mcp-app',
          text: '<!doctype html>',
          uri: 'ui://alpha/app',
        },
      },
      {
        reason: /exactly one of text or blob/,
        resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://alpha/app' },
      },
      {
        reason: /text exceeds 1048576 decoded bytes/,
        resource: {
          mimeType: 'text/html;profile=mcp-app',
          text: 'x'.repeat(1024 * 1024 + 1),
          uri: 'ui://alpha/app',
        },
      },
      {
        reason: /blob exceeds 1048576 decoded bytes/,
        resource: {
          blob: btoa('x'.repeat(1024 * 1024 + 1)),
          mimeType: 'text/html;profile=mcp-app',
          uri: 'ui://alpha/app',
        },
      },
    ]) {
      expect(() => authority.resolveResource(generation, tool, resource)).toThrow(reason);
    }
  });

  it('reads _meta.ui like a tool _meta: siblings ignored, empty bag means no metadata', () => {
    // Review of #2916: `_meta` is the MCP extension bag; a namespaced
    // sibling key must not reject the resource, and `_meta: {}` degrades to
    // `meta === undefined` instead of throwing.
    const authority = new McpAppProvenanceAuthority();
    const generation = authority.openGeneration({ generation: 1, serverId: 'alpha' });
    const tool = authority.registerTool(generation, {
      _meta: { ui: { resourceUri: 'ui://alpha/app' } },
      name: 'alpha-tool',
    });
    const base = {
      mimeType: 'text/html;profile=mcp-app',
      text: '<!doctype html>',
      uri: 'ui://alpha/app',
    };
    expect(
      authority.resolveResource(generation, tool, {
        ...base,
        _meta: { 'example.com/trace': 7, ui: { prefersBorder: true } },
      }).meta
    ).toMatchObject({ prefersBorder: true });
    expect(
      authority.resolveResource(generation, tool, { ...base, _meta: {} }).meta
    ).toBeUndefined();
  });

  it('retires a generation explicitly and keeps its number fenced against replay', () => {
    // Review of #2916: the explicit teardown path (disconnect without a
    // replacement) was uncovered. The latest generation number survives
    // retirement so a reconnect must still open a strictly greater one.
    const authority = new McpAppProvenanceAuthority();
    const generation = authority.openGeneration({ generation: 5, serverId: 'alpha' });
    const tool = authority.registerTool(generation, {
      _meta: { ui: { resourceUri: 'ui://alpha/app' } },
      name: 'alpha-tool',
    });
    authority.retireGeneration(generation);
    expect(() => authority.toolsFor(generation, 'app')).toThrow(/generation is retired/);
    expect(() =>
      authority.beginToolCall(generation, tool, { audience: 'app', id: 1, input: {} })
    ).toThrow(/generation is retired/);
    expect(() => authority.openGeneration({ generation: 5, serverId: 'alpha' })).toThrow(
      /increase monotonically/
    );
    expect(() => authority.retireGeneration(generation)).not.toThrow();
    expect(() =>
      authority.retireGeneration({ generation: 9, serverId: 'alpha' } as typeof generation)
    ).toThrow(/not owned by this authority/);
    const next = authority.openGeneration({ generation: 6, serverId: 'alpha' });
    expect(authority.toolsFor(next, 'app')).toEqual([]);
  });

  it('keeps the calling audience on a settled result', () => {
    // Review of #2916 (codex): a tool visible to both audiences would settle
    // otherwise identical results; the audience travels with the result.
    const authority = new McpAppProvenanceAuthority();
    const generation = authority.openGeneration({ generation: 1, serverId: 'alpha' });
    const tool = authority.registerTool(generation, {
      _meta: { ui: { resourceUri: 'ui://alpha/app' } },
      name: 'shared-tool',
    });
    const appCall = authority.beginToolCall(generation, tool, {
      audience: 'app',
      id: 1,
      input: {},
    });
    expect(authority.completeToolCall(generation, appCall, { ok: true })).toMatchObject({
      audience: 'app',
      id: 1,
    });
    const modelCall = authority.beginToolCall(generation, tool, {
      audience: 'model',
      id: 1,
      input: {},
    });
    expect(authority.completeToolCall(generation, modelCall, { ok: true })).toMatchObject({
      audience: 'model',
      id: 1,
    });
  });
});
