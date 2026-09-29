import { describe, expect, it } from 'vitest';
import {
  decodeMcpTaskAuthorityRow,
  decodeMcpTaskBlockedDiagnostic,
  decodeMcpTaskInputMetadata,
  decodeMcpTaskRow,
  decodeMcpTaskStatus,
} from '../src/repositories/mcp-task-row-schema';

const EPOCH = '01920000-0000-7000-8000-000000000001';
const SHA = 'a'.repeat(64);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authority_epoch: EPOCH,
    blocked_diagnostic: null,
    created_at: new Date('2026-09-24T10:00:00Z'),
    history: [{ at: '2026-09-24T10:00:00.000Z', status: 'working' }],
    input_metadata: null,
    principal_id: 'principal',
    resource: 'https://mcp.example.test/',
    result_metadata: { ok: true },
    server_id: 'server',
    status: 'working',
    status_message: null,
    task_id: 'task-1',
    terminal_at: null,
    updated_at: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

function diagnostic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actualBytes: 70_000,
    code: 'mcp_task_state_too_large',
    field: 'resultMetadata',
    maxBytes: 65_536,
    remoteStatus: 'completed',
    sha256: SHA,
    ...overrides,
  };
}

describe('MCP task row schema', () => {
  it('decodes a row, turning Date and ISO string timestamps into fresh Dates', () => {
    const createdAt = new Date('2026-09-24T10:00:00Z');
    const decoded = decodeMcpTaskRow(row({ created_at: createdAt }));

    expect(decoded.created_at).toEqual(createdAt);
    expect(decoded.created_at).not.toBe(createdAt);
    expect(decoded.history[0]?.at).toEqual(new Date('2026-09-24T10:00:00.000Z'));
    expect(decoded.updated_at).toBeInstanceOf(Date);
    expect(decoded.result_metadata).toEqual({ ok: true });
  });

  it.each([
    ['a non-object row', 'row', /^MCP task row must be an object\.$/u],
    [
      'an unparseable history timestamp',
      row({ history: [{ at: 'not a time', status: 'working' }] }),
      /^MCP task history\.at must be a valid timestamp\.\n {2}at \["history"\]\[0\]\["at"\]$/u,
    ],
    ['an empty history', row({ history: [] }), /^MCP task history must contain 1-32 entries\./u],
    ['an unknown status', row({ status: 'paused' }), /^MCP task status is invalid\./u],
    ['a non-UUIDv7 epoch', row({ authority_epoch: 'epoch' }), /^MCP task authorityEpoch must/u],
    [
      'an over-long task id',
      row({ task_id: 'x'.repeat(1025) }),
      /^MCP task taskId must contain 1-1024 UTF-8 bytes\./u,
    ],
    [
      'a non-finite metadata number',
      row({ input_metadata: { size: Number.NaN } }),
      /^MCP task inputMetadata must be a JSON object or null\./u,
    ],
    [
      'a bad terminal timestamp',
      row({ terminal_at: 'never' }),
      /^MCP task terminalAt must be a valid timestamp\./u,
    ],
    [
      'an over-long status message',
      row({ status_message: 'x'.repeat(4097) }),
      /^MCP task statusMessage must contain 0-4096 UTF-8 bytes\./u,
    ],
  ])('throws the repository sentence as a TypeError for %s', (_label, input, message) => {
    expect(() => decodeMcpTaskRow(input)).toThrow(TypeError);
    expect(() => decodeMcpTaskRow(input)).toThrow(message);
  });

  it.each([
    ['a non-object', 'diagnostic', /^MCP task blockedDiagnostic must be a JSON object or null\./u],
    ['an extra key', diagnostic({ extra: 1 }), /^MCP task blockedDiagnostic fields are invalid\./u],
    ['a missing key', { code: 'mcp_task_state_too_large' }, /fields are invalid/u],
    [
      'a bad digest',
      diagnostic({ sha256: 'xyz' }),
      /^MCP task blockedDiagnostic values are invalid\./u,
    ],
    ['bytes within budget', diagnostic({ actualBytes: 10 }), /values are invalid/u],
    ['a fractional budget', diagnostic({ maxBytes: 1.5 }), /values are invalid/u],
    ['an unknown remote status', diagnostic({ remoteStatus: 'paused' }), /status is invalid/u],
  ])('rejects a blocked diagnostic with %s', (_label, input, message) => {
    expect(() => decodeMcpTaskBlockedDiagnostic(input)).toThrow(message);
  });

  it('accepts a null or well-formed blocked diagnostic', () => {
    expect(decodeMcpTaskBlockedDiagnostic(null)).toBeNull();
    expect(decodeMcpTaskBlockedDiagnostic(diagnostic())).toEqual(diagnostic());
  });

  it('keeps an input-side failure message free of a path', () => {
    expect(() => decodeMcpTaskStatus('paused')).toThrow(/^MCP task status is invalid\.$/u);
    expect(() => decodeMcpTaskInputMetadata([1])).toThrow(
      /^MCP task inputMetadata must be a JSON object or null\.$/u
    );
  });

  it('decodes an authority row and rejects a negative connection generation', () => {
    const authority = {
      authority_epoch: EPOCH,
      connection_generation: '3',
      principal_id: 'principal',
      resource: 'https://mcp.example.test/',
      runtime_id: 'runtime',
      server_id: 'server',
    };

    expect(decodeMcpTaskAuthorityRow(authority).connection_generation).toBe(3);
    expect(() => decodeMcpTaskAuthorityRow({ ...authority, connection_generation: -1 })).toThrow(
      /^MCP task connectionGeneration must be a non-negative safe integer\./u
    );
  });
});
