import { ThreadLedgerFold } from '@brainstrike/agent-host/ledger-projection';
import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import { HostRunGenerations } from '../renderer/host-run-generations';
import type { CommittedHostRunSource } from '../renderer/host-thread-runs';

// Two recorded runs, each with an approved tool call and two model steps,
// served as Claude Sonnet 4.6 through OpenRouter.
const MODEL = 'openrouter::anthropic/claude-sonnet-4.6';
const BASE = Date.parse('2026-10-08T12:00:00Z');
const recorded: HostLogRow[] = richRecording.map((raw) => {
  const row = Schema.decodeUnknownSync(HostLogRowSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(raw);
  return { ...row, ts: BASE + row.seq * 1000 };
});
const runIds = recorded.flatMap(({ event }) => (event.type === 'run.started' ? [event.runId] : []));
const [firstRun = '', secondRun = ''] = runIds;

/** The first run admitted at high effort, as the desktop's Send intent records it. */
function withRunModel(rows: readonly HostLogRow[]): HostLogRow[] {
  return rows.map((row) => {
    if (row.event.type !== 'run.started') {
      return row;
    }
    const intent = {
      modelConfiguration: {
        model: 'anthropic/claude-sonnet-4.6',
        provider: 'openrouter',
        providerOptions: {
          openrouter: {
            provider: { ['require_parameters']: true },
            reasoning: { effort: 'high' },
          },
        },
      },
    };
    return {
      ...row,
      event: {
        ...row.event,
        modelId: MODEL,
        ...(row.event.runId === firstRun
          ? { snapshot: { configuration: { intent }, maxSteps: 20, toolIdentities: {} } }
          : {}),
      },
    };
  });
}
const rows = withRunModel(recorded);

class Source implements CommittedHostRunSource {
  private snapshot: ReturnType<CommittedHostRunSource['getSnapshot']> = {
    isLoading: false,
    replayedThrough: undefined,
    rows: [],
  };
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (): (() => void) => () => undefined;
  publish(log: readonly HostLogRow[]): void {
    this.snapshot = { isLoading: false, replayedThrough: log.at(-1)?.seq ?? 0, rows: log };
  }
}

function finishSteps(runId: string) {
  return rows.flatMap(({ event }) =>
    event.type === 'stream.chunk' &&
    event.runId === runId &&
    typeof event.chunk === 'object' &&
    event.chunk !== null &&
    !Array.isArray(event.chunk) &&
    event.chunk['type'] === 'finish-step'
      ? [event.chunk as { performance: { responseTimeMs: number; timeToFirstOutputMs: number } }]
      : []
  );
}

describe('HostRunGenerations', () => {
  test("reads a run's model, maker, route, effort, tokens, timings and cost from its committed rows", () => {
    const source = new Source();
    source.publish(rows);
    const generations = new HostRunGenerations(source);
    const ledger = new ThreadLedgerFold();
    for (const row of rows) {
      ledger.apply(row);
    }
    const ledgerRun = ledger.read().runs.find((run) => run.runId === firstRun);
    const steps = finishSteps(firstRun);

    expect(generations.read(firstRun)).toEqual({
      cost: { basis: 'estimated', usd: ledgerRun?.estimatedCostUsd },
      effort: 'high',
      finishReason: 'stop',
      firstOutputMs: steps[0]?.performance.timeToFirstOutputMs,
      model: { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (OpenRouter)' },
      modelTimeMs: steps.reduce((total, step) => total + step.performance.responseTimeMs, 0),
      outcome: 'completed',
      provider: { id: 'openrouter', name: 'OpenRouter' },
      // The mock provider names its own model in each response.
      servedModel: 'mock-model-id',
      steps: 2,
      tokens: { cacheRead: 0, cacheWrite: 0, input: 2, output: 50, reasoning: 2 },
      toolCalls: 1,
      vendor: { id: 'anthropic', name: 'Anthropic' },
      wallTimeMs: ledgerRun?.durationMs,
    });
    expect(ledgerRun?.estimatedCostUsd).toBeGreaterThan(0);
    // A run admitted without recorded settings states no effort rather than a guess.
    expect(generations.read(secondRun)?.effort).toBeUndefined();
    expect(generations.read('not-a-run')).toBeUndefined();
  });

  test('states what OpenRouter billed when it billed every step, and an estimate otherwise', () => {
    /** The first run's steps, the first `billed` of them reporting OpenRouter's $0.001 each. */
    const billed = (count: number): HostLogRow[] => {
      let step = 0;
      return rows.map((row) => {
        const { event } = row;
        if (event.type !== 'model.step' || event.runId !== firstRun || step++ >= count) {
          return row;
        }
        const usage = typeof event.usage === 'object' && event.usage !== null ? event.usage : {};
        return { ...row, event: { ...event, usage: { ...usage, raw: { cost: 0.001 } } } };
      });
    };
    const read = (log: readonly HostLogRow[]) => {
      const source = new Source();
      source.publish(log);
      return new HostRunGenerations(source).read(firstRun)?.cost;
    };
    expect(read(billed(2))).toEqual({ basis: 'billed', usd: 0.002 });
    // The unbilled step lists at $3 / $15 per million: 1 input and 25 output tokens.
    expect(read(billed(1))).toEqual({
      basis: 'estimated',
      usd: expect.closeTo(0.001 + (1 * 3 + 25 * 15) / 1e6, 12),
    });
  });

  test("keeps a run's value until one of its own facts commits", () => {
    const source = new Source();
    const cut = rows.findIndex(
      ({ event }) => event.type === 'model.step' && event.runId === firstRun
    );
    source.publish(rows.slice(0, cut));
    const generations = new HostRunGenerations(source);
    const running = generations.read(firstRun);
    expect(running).toMatchObject({ steps: 0 });
    expect(running?.outcome).toBeUndefined();
    // Reading again without new rows returns the same value.
    expect(generations.read(firstRun)).toBe(running);

    source.publish(rows.slice(0, cut + 1));
    const stepped = generations.read(firstRun);
    expect(stepped).not.toBe(running);
    expect(stepped).toMatchObject({ steps: 1 });

    source.publish(rows);
    expect(generations.read(firstRun)).toMatchObject({ outcome: 'completed', steps: 2 });
  });
});
