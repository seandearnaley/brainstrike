import { describe, expect, it } from 'vitest';
import { formatThreadDebugPack } from '../diagnostics/thread-debug-pack';

const toBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

describe('thread debug pack format', () => {
  it('redacts multiline secrets and reports corrupt artifacts without losing the pack', () => {
    const privateKey = [
      '-----BEGIN',
      'PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----',
    ].join(' ');
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    const snapshot = {
      capturedAt: '2026-09-12T00:00:00Z',
      rootThreadId: 'root',
      sections: {
        messages: [
          {
            content: privateKey,
            options: { apiKey },
          },
        ],
        toolOutputs: [],
      },
      threadId: 'root',
    };
    const pack = formatThreadDebugPack(snapshot);
    expect(pack).not.toContain('private-body');
    expect(pack).not.toContain(apiKey);
    expect(JSON.parse(pack).manifest.redaction.valueKinds).toContain('private-key');
    const corrupt = JSON.parse(
      formatThreadDebugPack({
        ...snapshot,
        sections: {
          toolOutputs: [
            {
              contentBase64: 'not base64!',
              format: 'json',
              id: 'bad-artifact',
              run_id: 'run-1',
              tool_call_id: 'call-1',
            },
          ],
        },
      })
    );
    expect(corrupt.sections.toolOutputs[0]).toMatchObject({
      content: null,
      contentError: { code: 'invalid-base64' },
      id: 'bad-artifact',
    });
    expect(corrupt.manifest.artifactDecodeFailures).toEqual([
      {
        artifactId: 'bad-artifact',
        code: 'invalid-base64',
        runId: 'run-1',
        toolCallId: 'call-1',
      },
    ]);
  });
  it('preserves large outputs and JSON structure while redacting decoded artifact credentials', () => {
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    const content = JSON.stringify({
      note: apiKey,
      nul: '\u0000',
      output: 'x'.repeat(210_000),
      password: 'private-value',
    });
    const pack = formatThreadDebugPack({
      capturedAt: '2026-09-12T00:00:00Z',
      rootThreadId: 'root',
      sections: {
        messages: [{ content: { parts: [{ text: 'hello', type: 'text' }] }, id: 'm1' }],
        runs: [
          { id: 'r1', status: 'running' },
          { id: 'r2', status: 'paused' },
          { id: 'r3', status: 'completed' },
        ],
        toolOutputs: [
          {
            byte_length: content.length,
            contentBase64: toBase64(content),
            format: 'json',
            id: 'artifact',
          },
        ],
      },
      threadId: 'root',
    });
    const parsed = JSON.parse(pack);
    expect(parsed.sections.toolOutputs[0].content.output).toHaveLength(210_000);
    expect(parsed.sections.toolOutputs[0].content.nul).toBe('\u0000');
    expect(pack).not.toContain('private-value');
    expect(pack).not.toContain(apiKey);
    expect(pack).not.toContain('contentBase64');
    expect(parsed.manifest.activeRunIds).toEqual(['r1', 'r2']);
    expect(parsed.manifest.retainedArtifactBytes).toBe(String(content.length));
    expect(parsed.manifest.counts.messages).toBe(1);
    expect(parsed.manifest.elidedRows).toBe(0);
    expect(pack).not.toContain('\n');
  });

  it('bounds deeply nested diagnostic values with visible evidence', () => {
    let nested: Record<string, unknown> = { value: 'leaf' };
    for (let index = 0; index < 80; index += 1) {
      nested = { nested };
    }
    const pack = formatThreadDebugPack({
      capturedAt: '2026-09-12T00:00:00Z',
      rootThreadId: 'root',
      sections: { diagnostics: [nested], toolOutputs: [] },
      threadId: 'root',
    });
    expect(pack).toContain('[TRUNCATED: maximum diagnostic depth]');
  });

  it('does not turn missing data into a claim of zero activity', () => {
    const pack = JSON.parse(
      formatThreadDebugPack({
        capturedAt: '2026-09-12T00:00:00Z',
        rootThreadId: 'root',
        sections: { messages: [], runs: [], toolOutputs: [] },
        threadId: 'root',
      })
    );
    expect(pack.manifest.coverage).toContain('retained');
    expect(pack.manifest.limitations.join(' ')).toContain('not evidence');
  });
});
