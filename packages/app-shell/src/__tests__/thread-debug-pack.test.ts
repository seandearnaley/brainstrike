import { describe, expect, it } from 'vitest';
import { formatThreadDebugPack } from '../diagnostics/thread-debug-pack';

describe('thread debug pack format', () => {
  it('redacts multiline secrets before JSON encoding and fails on corrupt artifacts', () => {
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
    expect(() =>
      formatThreadDebugPack({
        ...snapshot,
        sections: { toolOutputs: [{ contentBase64: 'not base64!' }] },
      })
    ).toThrow();
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
        runs: [{ id: 'r1', status: 'running' }],
        toolOutputs: [{ contentBase64: btoa(content), format: 'json', id: 'artifact' }],
      },
      threadId: 'root',
    });
    const parsed = JSON.parse(pack);
    expect(parsed.sections.toolOutputs[0].content.output).toHaveLength(210_000);
    expect(parsed.sections.toolOutputs[0].content.nul).toBe('\u0000');
    expect(pack).not.toContain('private-value');
    expect(pack).not.toContain(apiKey);
    expect(pack).not.toContain('contentBase64');
    expect(parsed.manifest.activeRunIds).toEqual(['r1']);
    expect(parsed.manifest.counts.messages).toBe(1);
    expect(parsed.manifest.elidedRows).toBe(0);
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
