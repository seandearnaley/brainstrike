import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MCP_ELICITATION_PRESENTATION_ID_MAX_LENGTH,
  MCP_ELICITATION_REQUEST_ID_MAX_LENGTH,
  MCP_SUPPORT_MATRIX,
  type McpElicitationPresentationWire,
  type McpElicitationSettlement,
  parseConfiguredMcpServerId,
  parseMcpElicitationSettlement,
} from '../index.js';

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const base = {
  configuredServerId: SERVER_ID,
  generation: 7,
  id: 'presentation-1',
  requestId: 'elicitation-1',
} as const;

describe('parseMcpElicitationSettlement', () => {
  it('accepts every presenter action with exactly the settle() input shape', () => {
    expect(
      parseMcpElicitationSettlement({
        ...base,
        action: 'accept',
        content: { confirm: true, tags: ['a'], workspace: 'Engineering' },
      })
    ).toEqual({
      ...base,
      action: 'accept',
      content: { confirm: true, tags: ['a'], workspace: 'Engineering' },
    });
    expect(parseMcpElicitationSettlement({ ...base, action: 'accept' })).toEqual({
      ...base,
      action: 'accept',
    });
    expect(parseMcpElicitationSettlement({ ...base, action: 'decline' })).toEqual({
      ...base,
      action: 'decline',
    });
    expect(parseMcpElicitationSettlement({ ...base, action: 'cancel', requestId: 42 })).toEqual({
      ...base,
      action: 'cancel',
      requestId: 42,
    });
    expectTypeOf<McpElicitationSettlement['action']>().toEqualTypeOf<
      'accept' | 'cancel' | 'decline'
    >();
  });

  it('rejects content on non-accept actions, unknown keys, and unsafe identifiers', () => {
    const invalid: unknown[] = [
      { ...base, action: 'decline', content: {} },
      { ...base, action: 'cancel', content: { workspace: 'x' } },
      { ...base, action: 'accept', extra: true },
      { ...base, action: 'approve' },
      { ...base, action: 'accept', generation: 1.5 },
      { ...base, action: 'accept', generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, action: 'accept', requestId: 2 ** 53 },
      {
        ...base,
        action: 'accept',
        requestId: 'r'.repeat(MCP_ELICITATION_REQUEST_ID_MAX_LENGTH + 1),
      },
      { ...base, action: 'accept', id: '' },
      { ...base, action: 'accept', configuredServerId: '' },
      { ...base, action: 'accept', configuredServerId: ' padded ' },
      { ...base, action: 'accept', configuredServerId: 'bad\u0000id' },
      { ...base, action: 'accept', id: 'i'.repeat(MCP_ELICITATION_PRESENTATION_ID_MAX_LENGTH + 1) },
      { ...base, action: 'accept', configuredServerId: '' },
      { ...base, action: 'accept', content: ['not', 'a', 'record'] },
      { ...base, action: 'accept', content: { fn: () => undefined } },
      { ...base, action: 'accept', content: { nested: { object: true } } },
      { ...base, action: 'accept', content: { nothing: null } },
      { ...base, action: 'accept', content: { mixed: ['a', 1] } },
      null,
      'accept',
    ];
    for (const value of invalid) {
      expect(() => parseMcpElicitationSettlement(value), JSON.stringify(value)).toThrow(
        /^Invalid MCP elicitation settlement: /u
      );
    }
  });

  it('keeps the wire presentation browser-safe and structurally complete', () => {
    const form: McpElicitationPresentationWire = {
      id: 'presentation-1',
      message: 'Choose a workspace',
      mode: 'form',
      provenance: {
        configuredProtocol: '2026-07-28',
        configuredServerId: SERVER_ID,
        generation: 7,
        invocationId: 'nonce:1',
        negotiatedRevision: '2026-07-28',
        operation: { target: 'search_issues', type: 'tools/call' },
        requestId: 'elicitation-1',
        serverIdentity: {
          name: 'Linear MCP',
          title: 'Linear',
          version: '2.0.0',
          websiteOrigin: 'https://linear.example',
        },
        transport: 'streamable-http',
      },
      requestedSchema: {
        properties: {
          confirm: { type: 'boolean' },
          count: { maximum: 10, minimum: 1, type: 'integer' },
          labels: { items: { enum: ['bug', 'chore'], type: 'string' }, type: 'array' },
          priority: {
            oneOf: [
              { const: 'p0', title: 'Urgent' },
              { const: 'p1', title: 'High' },
            ],
            type: 'string',
          },
          workspace: { format: 'email', maxLength: 64, minLength: 1, type: 'string' },
        },
        required: ['workspace'],
        type: 'object',
      },
    };
    const url: McpElicitationPresentationWire = {
      id: 'presentation-2',
      message: 'Authorize',
      mode: 'url',
      provenance: form.provenance,
      url: 'https://linear.example/authorize?flow=1',
    };
    expect(form.mode).toBe('form');
    expect(url.mode).toBe('url');
    expect(MCP_SUPPORT_MATRIX.find(({ id }) => id === 'core:elicitation')).toMatchObject({
      implementationTicket: 'BST-1584',
      kind: 'core',
    });
  });
});
