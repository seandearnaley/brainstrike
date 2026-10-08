import {
  MCP_STDIO_DIAGNOSTIC_MAX_ENTRIES,
  MCP_STDIO_DIAGNOSTIC_MAX_MESSAGE_CHARS,
  MCP_STDIO_DURABLE_FAILURE_MAX_ENTRIES,
  McpStdioDiagnosticCollector,
} from '@brainstrike/host-capabilities/mcp/stdio-diagnostics';
import { describe, expect, it, vi } from 'vitest';

describe('McpStdioDiagnosticCollector', () => {
  it('emits bounded line-safe diagnostics with OAuth material removed', () => {
    const emitted = vi.fn();
    const collector = new McpStdioDiagnosticCollector(emitted);
    const bearer = `Bearer ${'secret-token-'.repeat(4)}`;

    collector.write(
      'Open https://auth.example/authorize?code=oauth-code&state=oauth-state\r\n' +
        'Basic URL https://alice:password@example.com/private\n' +
        `Authorization: ${bearer}\ncode_verifier=pkce-secret&state=state-secret\n`
    );
    collector.write(
      `unsafe\u0000line ${'x'.repeat(MCP_STDIO_DIAGNOSTIC_MAX_MESSAGE_CHARS + 50)}\n`
    );
    collector.flush();

    const messages = emitted.mock.calls.map(([diagnostic]) => diagnostic.message).join('\n');
    expect(messages).toContain('https://auth.example/authorize?[redacted-query]');
    expect(messages).toContain('https://example.com/private');
    expect(messages).toContain('[redacted-oauth-parameter]');
    expect(messages).toContain('[redacted-secret:bearer-token]');
    expect(messages).not.toMatch(
      /oauth-code|oauth-state|pkce-secret|state-secret|secret-token|alice|password/u
    );
    expect(messages).not.toContain('\u0000');
    for (const [diagnostic] of emitted.mock.calls) {
      expect(diagnostic.message.length).toBeLessThanOrEqual(MCP_STDIO_DIAGNOSTIC_MAX_MESSAGE_CHARS);
      expect(diagnostic.stream).toBe('stderr');
    }
  });

  it('retains only the newest bounded diagnostics', () => {
    const collector = new McpStdioDiagnosticCollector();
    collector.write(
      Array.from(
        { length: MCP_STDIO_DIAGNOSTIC_MAX_ENTRIES + 3 },
        (_, index) => `line-${index}`
      ).join('\n')
    );
    collector.flush();

    expect(collector.snapshot()).toHaveLength(MCP_STDIO_DIAGNOSTIC_MAX_ENTRIES);
    expect(collector.snapshot()[0]?.message).toBe('line-3');
  });

  it('takes one bounded durable failure report with an honest omitted count', () => {
    const collector = new McpStdioDiagnosticCollector();
    const total = MCP_STDIO_DIAGNOSTIC_MAX_ENTRIES + 4;
    collector.write(Array.from({ length: total }, (_, index) => `line-${index}`).join('\n'));
    collector.flush();

    const report = collector.takeFailureReport();
    expect(report?.diagnostics).toHaveLength(MCP_STDIO_DURABLE_FAILURE_MAX_ENTRIES);
    expect(report?.diagnostics[0]?.message).toBe(`line-${total - 5}`);
    expect(report?.omittedDiagnostics).toBe(total - MCP_STDIO_DURABLE_FAILURE_MAX_ENTRIES);
    expect(collector.takeFailureReport()).toBeNull();
  });

  it('redacts structured, colon-delimited, escaped, and multiline secret values', () => {
    const collector = new McpStdioDiagnosticCollector();
    collector.write(
      '{"access_token":"json-secret","refresh_token":"refresh-secret"}\n' +
        'Authorization: colon-secret\n' +
        '{\\"token\\":\\"escaped-secret\\"}\n' +
        '{\n  "client_secret": "multiline-secret"\n}\n'
    );
    collector.flush();

    const messages = collector
      .snapshot()
      .map(({ message }) => message)
      .join('\n');
    expect(messages).toContain('[redacted-structured-secret]');
    expect(messages).not.toMatch(
      /json-secret|refresh-secret|colon-secret|escaped-secret|multiline-secret/u
    );
  });
});
