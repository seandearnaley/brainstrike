import { describe, expect, it, vi } from 'vitest';
import {
  collectThreadDebugHostEvidence,
  formatThreadDebugPack,
  type ThreadDebugHostEvidence,
} from '../diagnostics/thread-debug-pack';

const toBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

// Host evidence is a required, explicit input; these format cases are not about it.
const HOST_NOT_UNDER_TEST: ThreadDebugHostEvidence = {
  hostLog: { reason: 'not under test', status: 'unavailable' },
  processCounters: { reason: 'not under test', status: 'unavailable' },
  window: null,
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
    const pack = formatThreadDebugPack(snapshot, HOST_NOT_UNDER_TEST);
    expect(pack).not.toContain('private-body');
    expect(pack).not.toContain(apiKey);
    expect(JSON.parse(pack).manifest.redaction.valueKinds).toContain('private-key');
    const corrupt = JSON.parse(
      formatThreadDebugPack(
        {
          ...snapshot,
          sections: {
            toolOutputs: [
              {
                byte_length: 12,
                contentBase64: 'not base64!',
                format: 'json',
                id: 'bad-artifact',
                run_id: 'run-1',
                tool_call_id: 'call-1',
              },
              {
                byte_length: '1e5',
                contentBase64: toBase64('still readable'),
                format: 'text',
                id: 'bad-length',
                run_id: 'run-2',
                tool_call_id: 'call-2',
              },
            ],
          },
        },
        HOST_NOT_UNDER_TEST
      )
    );
    expect(corrupt.sections.toolOutputs[0]).toMatchObject({
      content: null,
      contentError: { code: 'invalid-base64' },
      id: 'bad-artifact',
    });
    expect(corrupt.sections.toolOutputs[1].content).toBe('still readable');
    expect(corrupt.manifest.artifactFailures).toEqual([
      {
        artifactId: 'bad-artifact',
        code: 'invalid-base64',
        runId: 'run-1',
        toolCallId: 'call-1',
      },
      {
        artifactId: 'bad-length',
        code: 'invalid-byte-length',
        runId: 'run-2',
        toolCallId: 'call-2',
      },
    ]);
    expect(corrupt.manifest.retainedArtifactBytes).toBe('12');
    expect(corrupt.manifest.retainedArtifactBytesComplete).toBe(false);
  });
  it('preserves large outputs and JSON structure while redacting decoded artifact credentials', () => {
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    const content = JSON.stringify({
      note: apiKey,
      nul: '\u0000',
      output: 'x'.repeat(210_000),
      password: 'private-value',
    });
    const pack = formatThreadDebugPack(
      {
        capturedAt: '2026-09-12T00:00:00Z',
        rootThreadId: 'root',
        sections: {
          messages: [{ content: { parts: [{ text: 'hello', type: 'text' }] }, id: 'm1' }],
          runs: [
            { id: 'r1', status: 'running', thread_id: 'root' },
            { id: 'r2', status: 'paused', thread_id: 'root' },
            { id: 'r3', status: 'completed', thread_id: 'root' },
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
      },
      HOST_NOT_UNDER_TEST
    );
    const parsed = JSON.parse(pack);
    expect(parsed.sections.toolOutputs[0].content.output).toHaveLength(210_000);
    expect(parsed.sections.toolOutputs[0].content.nul).toBe('\u0000');
    expect(pack).not.toContain('private-value');
    expect(pack).not.toContain(apiKey);
    expect(pack).not.toContain('contentBase64');
    expect(parsed.manifest.activeRunIds).toEqual(['r1']);
    expect(parsed.manifest.unknownRunStatuses).toEqual([{ runId: 'r2', status: 'paused' }]);
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
    const pack = formatThreadDebugPack(
      {
        capturedAt: '2026-09-12T00:00:00Z',
        rootThreadId: 'root',
        sections: { diagnostics: [nested], toolOutputs: [] },
        threadId: 'root',
      },
      HOST_NOT_UNDER_TEST
    );
    expect(pack).toContain('[TRUNCATED: maximum diagnostic depth]');
    expect(JSON.parse(pack).manifest.structuralElisions).toEqual({ depth: 1, repeated: 0 });
  });

  it('does not turn missing data into a claim of zero activity', () => {
    const pack = JSON.parse(
      formatThreadDebugPack(
        {
          capturedAt: '2026-09-12T00:00:00Z',
          rootThreadId: 'root',
          sections: { messages: [], runs: [], toolOutputs: [] },
          threadId: 'root',
        },
        HOST_NOT_UNDER_TEST
      )
    );
    expect(pack.manifest.coverage).toContain('retained');
    expect(pack.manifest.limitations.join(' ')).toContain('not evidence');
  });
});

describe('thread debug pack swarm diagnostics', () => {
  const GATE = {
    askTools: [{ riskCategory: 'read', tool: 'brainstrike.readWorkspaceFile' }],
    defaultRisk: null,
    deniedTools: [],
    grantedCategories: [],
    omittedAskTools: [],
    overrideCount: 0,
    policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
    yolo: false,
  };

  it('derives legs and child first steps, lists resolved gates and embeds host evidence a probe answered', async () => {
    const snapshot = {
      capturedAt: '2026-09-15T03:31:15.785Z',
      rootThreadId: 'root',
      sections: {
        events: [
          {
            kind: 'permission.gate.resolved',
            metadata: GATE,
            run_id: 'r1',
            status: 'completed',
            thread_id: 'root',
          },
          {
            kind: 'run.step.finished',
            metadata: { finishReason: 'tool-calls', openRouterProvider: 'Mistral' },
            run_id: 'r1',
            status: 'completed',
            thread_id: 'root',
          },
          {
            kind: 'run.finished',
            metadata: { finishReason: 'stop', openRouterProvider: 'Mistral' },
            run_id: 'r1',
            status: 'completed',
            thread_id: 'root',
          },
        ],
        promptManifests: [
          {
            created_at: '2026-09-15T03:27:31.000+00:00',
            id: 'pm-child',
            kind: 'child-first-step',
            native_run_id: 'native-root',
            parent_tool_call_id: 'delegate-call',
            persona_id: 'explore',
            thread_id: 'root',
          },
        ],
        runs: [
          {
            id: 'r1',
            model: 'z-ai/glm-5.2',
            provider: 'openrouter',
            started_at: '2026-09-15T03:27:29.995+00:00',
            status: 'completed',
            thread_id: 'root',
          },
        ],
        toolOutputs: [],
      },
      threadId: 'root',
    };
    const readMainLogWindow = vi.fn().mockResolvedValue({
      counts: { wasmAllocationFailures: 62 },
      lines: ['{"level":50,"msg":"Cannot allocate Wasm memory"}'],
    });
    const readProcessCounters = vi
      .fn()
      .mockResolvedValue({ installedAt: 'x', samples: [{ wasm: { instantiate: 900 } }] });

    const evidence = await collectThreadDebugHostEvidence(
      { readMainLogWindow, readProcessCounters },
      snapshot
    );
    const pack = JSON.parse(formatThreadDebugPack(snapshot, evidence));

    const window = { since: '2026-09-15T03:27:29.995Z', until: '2026-09-15T03:31:15.785Z' };
    expect(readMainLogWindow).toHaveBeenCalledWith(window);
    expect(pack.sections.legs).toEqual([
      expect.objectContaining({
        finishReason: 'stop',
        openRouterProviders: ['Mistral'],
        runId: 'r1',
        steps: 1,
      }),
    ]);
    expect(pack.sections.childFirstSteps).toEqual([
      expect.objectContaining({ manifestId: 'pm-child', reentryManifestIds: [] }),
    ]);
    expect(pack.sections.hostLog.counts.wasmAllocationFailures).toBe(62);
    expect(pack.sections.processCounters.samples[0].wasm.instantiate).toBe(900);
    expect(pack.manifest.host).toEqual({
      hostLog: 'included',
      processCounters: 'included',
      window,
    });
    expect(pack.manifest.counts.legs).toBe(1);
    expect(pack.manifest.counts).not.toHaveProperty('hostLog');
    expect(pack.manifest.permissionGates).toEqual([
      { metadata: GATE, runId: 'r1', threadId: 'root' },
    ]);
    expect(pack.guide.join(' ')).toContain('childFirstSteps');
  });

  it('names why host evidence is missing and clamps the log window to 24 hours', async () => {
    const snapshot = {
      capturedAt: '2026-09-16T03:00:00.000Z',
      rootThreadId: 'root',
      sections: {
        runs: [
          {
            id: 'r1',
            started_at: '2026-09-10T00:00:00.000Z',
            status: 'completed',
            thread_id: 'root',
          },
        ],
        toolOutputs: [],
      },
      threadId: 'root',
    };

    const noBridge = JSON.parse(
      formatThreadDebugPack(snapshot, await collectThreadDebugHostEvidence(null, snapshot))
    );
    expect(noBridge.sections.hostLog).toBeNull();
    expect(noBridge.sections.processCounters).toBeNull();
    expect(noBridge.manifest.host.hostLog).toMatch(/^unavailable: no desktop diagnostics bridge/);
    expect(noBridge.manifest.host.processCounters).toMatch(
      /^unavailable: no desktop diagnostics bridge/
    );
    expect(noBridge.manifest.host.window).toBeNull();

    const failed = JSON.parse(
      formatThreadDebugPack(
        snapshot,
        await collectThreadDebugHostEvidence(
          {
            readMainLogWindow: vi
              .fn()
              .mockRejectedValue(new Error('Main log file logging is disabled')),
            readProcessCounters: vi.fn().mockResolvedValue({ installedAt: null }),
          },
          snapshot
        )
      )
    );
    expect(failed.manifest.host).toEqual({
      hostLog: 'unavailable: Main log file logging is disabled',
      processCounters: 'unavailable: malformed process counter result (no samples array)',
      window: { since: '2026-09-15T03:00:00.000Z', until: '2026-09-16T03:00:00.000Z' },
    });
    expect(failed.sections.processCounters).toBeNull();
  });

  it('does not read the host log without a run start to bound its window', async () => {
    const readMainLogWindow = vi.fn();
    const evidence = await collectThreadDebugHostEvidence(
      { readMainLogWindow, readProcessCounters: vi.fn().mockResolvedValue({ samples: [] }) },
      {
        capturedAt: '2026-09-16T03:00:00.000Z',
        rootThreadId: 'root',
        sections: { runs: [] },
        threadId: 'root',
      }
    );
    expect(readMainLogWindow).not.toHaveBeenCalled();
    expect(evidence.hostLog).toEqual({
      reason: 'no run start in the snapshot to bound the log window',
      status: 'unavailable',
    });
    expect(evidence.processCounters).toEqual({ status: 'included', value: { samples: [] } });
  });

  it('redacts secrets inside prompt manifests, wakeups, host log lines and listed gates', () => {
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    const pack = formatThreadDebugPack(
      {
        capturedAt: '2026-09-15T00:00:00Z',
        rootThreadId: 'root',
        sections: {
          events: [
            {
              kind: 'permission.gate.resolved',
              metadata: { askTools: [{ riskCategory: 'mcp', tool: `mcp ${apiKey}` }] },
              run_id: 'r1',
              thread_id: 'root',
            },
          ],
          promptManifests: [
            {
              id: 'pm',
              kind: 'root-leg',
              persona_instructions: `use ${apiKey}`,
              system_messages: [{ content: `key ${apiKey}`, role: 'system' }],
              thread_id: 'root',
            },
          ],
          toolOutputs: [],
          wakeups: [{ directive: `token ${apiKey}`, id: 'wk' }],
        },
        threadId: 'root',
      },
      {
        hostLog: { status: 'included', value: { lines: [`{"msg":"${apiKey}"}`] } },
        processCounters: { reason: 'not under test', status: 'unavailable' },
        window: null,
      }
    );
    expect(pack).not.toContain(apiKey);
    expect(JSON.parse(pack).manifest.redaction.valueCount).toBe(5);
  });

  it('scrubs and counts a secret shape inside each unavailable host evidence reason', () => {
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    const pack = formatThreadDebugPack(
      {
        capturedAt: '2026-09-15T00:00:00Z',
        rootThreadId: 'root',
        sections: { toolOutputs: [] },
        threadId: 'root',
      },
      {
        hostLog: {
          reason: `not readable at /tmp/${apiKey}/brainstrike.log`,
          status: 'unavailable',
        },
        processCounters: {
          reason: `counter read rejected for ${apiKey} by main`,
          status: 'unavailable',
        },
        window: null,
      }
    );
    expect(pack).not.toContain(apiKey);
    const { manifest } = JSON.parse(pack);
    // Paths are documented export content: only the secret shape is replaced.
    expect(manifest.host.hostLog).toBe(
      'unavailable: not readable at /tmp/[redacted-secret:api-key]/brainstrike.log'
    );
    expect(manifest.host.processCounters).toBe(
      'unavailable: counter read rejected for [redacted-secret:api-key] by main'
    );
    expect(manifest.redaction.valueCount).toBe(2);
  });
});
