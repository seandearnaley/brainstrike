import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { parseLensFile } from '@brainstrike/assistant-contract';
import {
  addLogListener,
  LogLevel,
  type LogRecord,
  resetLogger,
  setLogLevel,
} from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  injectSelfImprovementSignalContext,
  SELF_IMPROVEMENT_SIGNAL_SQL,
} from '../../assistant-server/self-improvement-signal-context';

const EXPECTED_COLUMNS = [
  'tool_id',
  'calls',
  'total_model_facing_chars',
  'truncation_hit_rate',
  'zero_match_rate',
  'waste_score',
] as const;

const NOW = new Date('2026-08-10T16:30:00.000Z');

function messages(): AgentMessage[] {
  return [{ id: 'user-1', parts: [{ text: 'Help me.', type: 'text' }], role: 'user' }];
}

function runtime(preference: unknown = { enabled: true }): RuntimeData {
  return {
    provider: 'openai',
    selfImprovementSignalPreference: preference,
  } as RuntimeData;
}

function logsDuring<T>(run: () => Promise<T>): Promise<{ records: LogRecord[]; result: T }> {
  const records: LogRecord[] = [];
  const stop = addLogListener((record) => records.push(record));
  return run()
    .then((result) => ({ records, result }))
    .finally(stop);
}

function systemText(result: readonly AgentMessage[]): string {
  const first = result[0];
  if (first?.role !== 'system') {
    return '';
  }
  return first.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('injectSelfImprovementSignalContext', () => {
  it.each([
    undefined,
    {},
  ])('returns the same array and does not query when the preference is %j', async (preference) => {
    const input = messages();
    const runSignalQuery = vi.fn();

    const result = await injectSelfImprovementSignalContext(
      input,
      preference === undefined ? { provider: 'openai' } : runtime(preference),
      { now: () => NOW, runSignalQuery }
    );

    expect(result).toBe(input);
    expect(runSignalQuery).not.toHaveBeenCalled();
  });

  it.each([
    'enabled',
    { enabled: 'yes' },
  ])('warns and treats malformed preference %j as off', async (preference) => {
    const input = messages();
    const runSignalQuery = vi.fn();

    const { records, result } = await logsDuring(() =>
      injectSelfImprovementSignalContext(input, runtime(preference), {
        now: () => NOW,
        runSignalQuery,
      })
    );

    expect(result).toBe(input);
    expect(runSignalQuery).not.toHaveBeenCalled();
    expect(
      records.some(
        (record) =>
          record.level === LogLevel.WARN &&
          String(record.message).includes('selfImprovementSignalPreference')
      )
    ).toBe(true);
  });

  it('prepends one exact system message and queries the previous 24 hours', async () => {
    const input = messages();
    const runSignalQuery = vi.fn(async () => ({
      columns: [...EXPECTED_COLUMNS],
      rows: [
        ['grepSearch', 65, 100_000, 0.98, 0.42, 140_000],
        ['globWorkspace', 23, 50_000, 1, 0.78, 89_000],
      ],
    }));

    const result = await injectSelfImprovementSignalContext(input, runtime(), {
      now: () => NOW,
      runSignalQuery,
    });

    expect(result).toHaveLength(2);
    expect(result[1]).toBe(input[0]);
    expect(systemText(result)).toBe(
      '## Self-assessment signal (agent tool telemetry, last 24h)\n' +
        'Top tool waste, ranked (truncation = output cut to budget; zero-match = call found nothing):\n' +
        '- grepSearch: 65 calls, 98% truncated, 42% zero-match\n' +
        '- globWorkspace: 23 calls, 100% truncated, 78% zero-match\n' +
        'Adapt: scope searches (filePaths/narrower patterns) and read selectively to reduce this waste.'
    );
    expect(runSignalQuery).toHaveBeenCalledWith(SELF_IMPROVEMENT_SIGNAL_SQL, [
      '2026-08-09T16:30:00.000Z',
      '2026-08-10T16:30:00.000Z',
      5,
    ]);
  });

  it('excludes zero-waste rows and omits the zero-match clause for NULL', async () => {
    const input = messages();
    const result = await injectSelfImprovementSignalContext(input, runtime(), {
      now: () => NOW,
      runSignalQuery: async () => ({
        columns: [...EXPECTED_COLUMNS],
        rows: [
          ['readWorkspaceFile', 4, 1200, 0.25, null, 300],
          ['cleanTool', 50, 5000, 0, 0, 0],
        ],
      }),
    });

    const text = systemText(result);
    expect(text).toContain('- readWorkspaceFile: 4 calls, 25% truncated\n');
    expect(text).not.toContain('readWorkspaceFile: 4 calls, 25% truncated,');
    expect(text).not.toContain('cleanTool');
  });

  it('warns and preserves array identity when the query rejects', async () => {
    const input = messages();
    const { records, result } = await logsDuring(() =>
      injectSelfImprovementSignalContext(input, runtime(), {
        now: () => NOW,
        runSignalQuery: async () => Promise.reject(new Error('database unavailable')),
      })
    );

    expect(result).toBe(input);
    expect(
      records.some(
        (record) =>
          record.level === LogLevel.WARN && record.message === 'self_improvement_signal_failed'
      )
    ).toBe(true);
  });

  it('debug logs and preserves array identity when no row has positive waste', async () => {
    const input = messages();
    setLogLevel(LogLevel.DEBUG);
    try {
      const { records, result } = await logsDuring(() =>
        injectSelfImprovementSignalContext(input, runtime(), {
          now: () => NOW,
          runSignalQuery: async () => ({
            columns: [...EXPECTED_COLUMNS],
            rows: [['cleanTool', 5, 500, 0, 0, 0]],
          }),
        })
      );

      expect(result).toBe(input);
      expect(records.some((record) => record.level === LogLevel.DEBUG)).toBe(true);
    } finally {
      resetLogger();
    }
  });

  it('does not query for the built-in local provider even when enabled', async () => {
    const input = messages();
    const runSignalQuery = vi.fn();
    const result = await injectSelfImprovementSignalContext(
      input,
      { ...runtime(), provider: 'local' },
      { now: () => NOW, runSignalQuery }
    );

    expect(result).toBe(input);
    expect(runSignalQuery).not.toHaveBeenCalled();
  });

  it('warns and fails closed when the query returns unexpected columns', async () => {
    const input = messages();
    const { records, result } = await logsDuring(() =>
      injectSelfImprovementSignalContext(input, runtime(), {
        now: () => NOW,
        runSignalQuery: async () => ({
          columns: ['tool_id', 'calls', 'waste_score'],
          rows: [['grepSearch', 10, 100]],
        }),
      })
    );

    expect(result).toBe(input);
    expect(
      records.some(
        (record) =>
          record.level === LogLevel.WARN && String(record.message).includes('unexpected_columns')
      )
    ).toBe(true);
  });

  it('keeps a five-row signal with long tool ids under 500 characters', async () => {
    const input = messages();
    const rows = Array.from({ length: 5 }, (_, index) => [
      `longWorkspaceTool${index}`,
      1,
      10,
      0,
      null,
      1,
    ]);
    const result = await injectSelfImprovementSignalContext(input, runtime(), {
      now: () => NOW,
      runSignalQuery: async () => ({ columns: [...EXPECTED_COLUMNS], rows }),
    });

    expect(systemText(result).length).toBeLessThan(500);
  });
});

describe('SELF_IMPROVEMENT_SIGNAL_SQL', () => {
  it('stays byte-equal to the shipped self-improvement-signal lens SQL body', () => {
    const lensPath = resolve(
      import.meta.dirname,
      '../../../../../.brainstrike/lenses/self-improvement-signal.sql'
    );
    const parsed = parseLensFile('self-improvement-signal.sql', readFileSync(lensPath, 'utf8'));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    expect(parsed.lens.sql.trim()).toBe(SELF_IMPROVEMENT_SIGNAL_SQL.trim());
  });
});
