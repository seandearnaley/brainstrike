import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDatabaseMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: () => getDatabaseMock(),
}));

const { buildHostNativeTools } = await import('./_host-native-tools');
const { runQueryDiagnostics } = await import('../../assistant-server/query-diagnostics-tool');

beforeEach(() => {
  getDatabaseMock.mockReset();
});

describe('queryDiagnostics native tool', () => {
  it('is registered under the canonical desktop-native id', () => {
    const tools = buildHostNativeTools({}, { ids: [NATIVE_TOOL_ID.queryDiagnostics] });

    expect(tools).toHaveProperty(NATIVE_TOOL_ID.queryDiagnostics);
  });

  it('queries bounded diagnostic events with exact filters', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          app_version: '1.0.0',
          cause_chain: null,
          code: 'provider_failed',
          context: null,
          fingerprint: 'fp-provider',
          id: 'event-1',
          message: 'Provider failed',
          occurred_at: new Date(5000),
          platform: 'darwin',
          resource_id: null,
          root_id: 'root-1',
          run_id: 'run-1',
          scope: 'Assistant',
          session_id: 'session-1',
          severity: 'error',
          source: 'electron-main',
          stack: null,
          thread_id: 'thread-1',
        },
      ],
    });
    getDatabaseMock.mockResolvedValue({ query });

    const result = await runQueryDiagnostics({
      limit: 25,
      mode: 'events',
      runId: 'run-1',
      severity: 'error',
      since: '1970-01-01T00:00:01.000Z',
      until: '1970-01-01T00:00:06.000Z',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY occurred_at DESC, id DESC LIMIT 25'),
      ['error', 'run-1', '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:06.000Z']
    );
    expect(result).toMatchObject({
      kind: 'events',
      returned: 1,
      totalMatchedWithinCap: 1,
      truncated: false,
    });
    expect(result.items[0]).toMatchObject({
      fingerprint: 'fp-provider',
      id: 'event-1',
      occurredAt: 5000,
    });
  });

  it('scrubs credential-shaped values from every projected diagnostic field', async () => {
    const githubToken = `ghp_${'a'.repeat(36)}`;
    const openAiKey = `sk-${'b'.repeat(24)}`;
    const slackToken = `xoxb-${'c'.repeat(20)}`;
    const jwt = `eyJ${'d'.repeat(12)}.${'e'.repeat(12)}.${'f'.repeat(8)}`;
    getDatabaseMock.mockResolvedValue({
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            app_version: '1.0.0',
            cause_chain: [{ message: `upstream ${slackToken}` }],
            code: 'provider_failed',
            context: { response: `Authorization: Bearer ${jwt}` },
            fingerprint: 'fp-provider',
            id: 'event-secret',
            message: `Provider returned ${githubToken}`,
            occurred_at: new Date(5000),
            platform: 'darwin',
            resource_id: null,
            root_id: 'root-1',
            run_id: 'run-1',
            scope: 'Assistant',
            session_id: 'session-1',
            severity: 'error',
            source: 'electron-main',
            stack: `Error: ${openAiKey}`,
            thread_id: 'thread-1',
          },
        ],
      }),
    });

    const result = await runQueryDiagnostics({ mode: 'events' });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(githubToken);
    expect(serialized).not.toContain(openAiKey);
    expect(serialized).not.toContain(slackToken);
    expect(serialized).not.toContain(jwt);
    expect(serialized).toContain('[redacted-secret:github-token]');
    expect(serialized).toContain('[redacted-secret:api-key]');
    expect(serialized).toContain('[redacted-secret:slack-token]');
    expect(serialized).toContain('[redacted-secret:bearer-token]');
  });

  it('rejects invalid time bounds with actionable input errors', async () => {
    await expect(
      runQueryDiagnostics({
        mode: 'events',
        since: 'definitely-not-a-timestamp',
      })
    ).rejects.toThrow('since must be a valid ISO-8601 timestamp');
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('rejects a reversed time range before opening the database', async () => {
    await expect(
      runQueryDiagnostics({
        mode: 'events',
        since: '2026-07-28T02:00:00.000Z',
        until: '2026-07-28T01:00:00.000Z',
      })
    ).rejects.toThrow('since must be earlier than or equal to until');
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('returns fingerprint groups and reports output-budget truncation explicitly', async () => {
    const oversizedMessage = 'x'.repeat(12_000);
    getDatabaseMock.mockResolvedValue({
      query: vi.fn().mockResolvedValue({
        rows: Array.from({ length: 20 }, (_unused, index) => ({
          code: 'provider_failed',
          count: 10 - index,
          fingerprint: `fp-${index}`,
          first_seen: new Date(1000 + index),
          last_seen: new Date(5000 + index),
          latest_message: oversizedMessage,
          severity: 'error',
          source: 'electron-main',
        })),
      }),
    });

    const result = await runQueryDiagnostics({ limit: 20, mode: 'fingerprints' });

    expect(result.kind).toBe('fingerprints');
    expect(result.truncated).toBe(true);
    expect(result.returned).toBeLessThan(20);
    expect(result.hint).toMatch(/output budget/i);
    expect(result.hint).toMatch(/20-group cap was also reached/i);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(11_000);
  });
});
