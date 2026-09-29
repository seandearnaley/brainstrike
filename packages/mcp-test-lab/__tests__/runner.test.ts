import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { McpArtifactIntegrityDependencies } from '../src/evidence';
import { mcpEvidenceCapabilitiesFor } from '../src/evidence-schema';
import {
  type McpLabRunnerCaseObservation,
  type McpLabRunnerDependencies,
  type McpLabRunnerPhase,
  type McpLabVerificationInput,
  runMcpLabVerification,
} from '../src/runner';
import {
  type McpLabRunnerCase,
  McpLabRunnerDeadlineError,
  type McpLabRunnerProfile,
} from '../src/runner-manifest';
import { MCP_LAB_SCENARIO_IDS } from '../src/scenario';

const COMMAND = 'pnpm --filter @brainstrike/mcp-test-lab verify -- --profile pr';
const INTEGRITY = { maxArtifactBytes: 1024, readArtifactContent: () => new Uint8Array() };
// The runner reserves floor(timeout / 4) of a phase for cleanup, so a 400 ms case
// keeps 100 ms for a ~5 ms close. A scheduler stall that makes the operation timer
// fire late eats that reserve, so a tiny budget flakes on a loaded runner.
const RESERVE_BUDGET = { caseTimeoutMs: 400, runTimeoutMs: 400 } as const;
const CLEANUP_RESERVE_MS = RESERVE_BUDGET.caseTimeoutMs / 4;

/** Blocks the event loop on the real clock, as a slow synchronous step would. */
function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy-wait: nothing else may run while the runner is charged this time.
  }
}

function input(
  profile: McpLabRunnerProfile = 'pr',
  overrides: Readonly<Partial<McpLabVerificationInput>> = {}
): McpLabVerificationInput {
  return {
    blockers: [],
    command: COMMAND,
    git: {
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      workspaceState: 'clean',
    },
    selection: { profile },
    ticket: 'BST-1494',
    ...overrides,
  };
}

function observation(
  runnerCase: McpLabRunnerCase,
  phase: McpLabRunnerPhase
): McpLabRunnerCaseObservation {
  const passed = phase === 'red' ? 0 : 1;
  const failed = phase === 'red' ? 1 : 0;
  const negotiation =
    runnerCase.scenarioId === 'legacy-reference'
      ? ({ era: 'legacy', revision: '2025-11-25' } as const)
      : ({ era: 'modern', revision: '2026-07-28' } as const);
  return {
    capabilities: [...mcpEvidenceCapabilitiesFor(runnerCase.scenarioId)],
    correlationIds: [`${runnerCase.id}-${phase}`],
    exitStatus: phase === 'red' ? 1 : 0,
    negotiation,
    tests: { failed, passed, skipped: 0, total: 1 },
  };
}

function dependencies(
  events: string[],
  options: {
    readonly cleanupFailure?: Error;
    /** Synchronous time spent inside createPhaseOwner, before the run timer starts. */
    readonly createDelayMs?: number;
    readonly lateRunFailure?: Error;
    readonly mapObservation?: (
      value: McpLabRunnerCaseObservation,
      phase: McpLabRunnerPhase
    ) => McpLabRunnerCaseObservation;
    readonly runFailure?: Error;
    readonly runNeverSettles?: boolean;
    readonly runSettlesAfterClose?: boolean;
  } = {}
): McpLabRunnerDependencies {
  return {
    createPhaseOwner(runnerCase, phase) {
      events.push(`create:${runnerCase.id}:${phase}`);
      if (options.createDelayMs) {
        spin(options.createDelayMs);
      }
      let settleRun: (() => void) | undefined;
      return {
        async close(signal) {
          signal.addEventListener('abort', () =>
            events.push(`abort-cleanup:${runnerCase.id}:${phase}`)
          );
          events.push(`close:${runnerCase.id}:${phase}`);
          if (options.cleanupFailure) {
            throw options.cleanupFailure;
          }
          if (options.runSettlesAfterClose || options.lateRunFailure) {
            await delay(5);
            settleRun?.();
          }
          return { details: `closed ${runnerCase.id} ${phase}`, verified: true };
        },
        async run() {
          events.push(`run:${runnerCase.id}:${phase}`);
          if (options.runFailure) {
            throw options.runFailure;
          }
          if (options.runNeverSettles) {
            await new Promise(() => undefined);
          }
          if (options.lateRunFailure) {
            await new Promise<void>((_resolve, reject) => {
              settleRun = () => reject(options.lateRunFailure);
            });
          } else if (options.runSettlesAfterClose) {
            await new Promise<void>((resolve) => {
              settleRun = resolve;
            });
          }
          const value = observation(runnerCase, phase);
          return options.mapObservation?.(value, phase) ?? value;
        },
      };
    },
    now: () => performance.now(),
  };
}

function verifySingleCase(
  deps: McpLabRunnerDependencies,
  selection: Readonly<Record<string, unknown>> = {},
  integrity: McpArtifactIntegrityDependencies = INTEGRITY
) {
  return runMcpLabVerification(
    input('pr', {
      selection: { caseIds: ['modern-stdio'], profile: 'pr', ...selection },
    }),
    deps,
    integrity
  );
}

describe('MCP bounded verification runner', () => {
  it('executes RED, GREEN, and verification serially and emits verified frozen evidence', async () => {
    const events: string[] = [];
    const readArtifactContent = vi.fn(() => new Uint8Array());
    const result = await runMcpLabVerification(
      input('pr', {
        selection: {
          caseIds: ['modern-http-in-process', 'modern-stdio'],
          profile: 'pr',
        },
      }),
      dependencies(events),
      { maxArtifactBytes: 1024, readArtifactContent }
    );

    expect(result.map(({ schema }) => schema.scenarioId)).toEqual([
      'modern-reference',
      'stdio-reference',
    ]);
    for (const { schema } of result) {
      expect(MCP_LAB_SCENARIO_IDS).toContain(schema.scenarioId);
    }
    expect(result[0]?.schema.commands.map(({ phase }) => phase)).toEqual([
      'red',
      'green',
      'verification',
    ]);
    expect(result[0]?.schema.correlationIds).toEqual([
      'modern-http-in-process-red',
      'modern-http-in-process-green',
      'modern-http-in-process-verification',
    ]);
    expect(events).toHaveLength(18);
    expect(events.slice(0, 3).join('|')).toBe(
      'create:modern-http-in-process:red|run:modern-http-in-process:red|close:modern-http-in-process:red'
    );
    expect(events.slice(-3).join('|')).toBe(
      'create:modern-stdio:verification|run:modern-stdio:verification|close:modern-stdio:verification'
    );
    expect(readArtifactContent).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]?.schema)).toBe(true);
  });

  it('reserves cleanup time and waits for an aborted run to settle', async () => {
    const events: string[] = [];
    await expect(
      verifySingleCase(dependencies(events, { runSettlesAfterClose: true }), RESERVE_BUDGET)
      // The error names the phase budget, ceil(remaining run time), which loses
      // whatever elapsed before RED started ("90 ms" on a loaded CI runner), so
      // only its shape is asserted. The deadline clock stays real: a frozen one
      // would leave the full budget for cleanup and hide a lost cleanup reserve.
    ).rejects.toThrow(/modern-stdio.*red.*\d+ ms/i);
    expect(events).toEqual([
      'create:modern-stdio:red',
      'run:modern-stdio:red',
      'close:modern-stdio:red',
    ]);
  });

  it('charges time spent before the run starts to the operation, not the cleanup reserve', async () => {
    const events: string[] = [];
    const failure = verifySingleCase(
      // Twice the reserve: an operation timer that starts after this delay and
      // still runs its full budget leaves cleanup no time at all.
      dependencies(events, { createDelayMs: 2 * CLEANUP_RESERVE_MS, runSettlesAfterClose: true }),
      RESERVE_BUDGET
    );

    await expect(failure).rejects.toThrow(
      /^MCP lab runner case "modern-stdio\/red" exceeded \d+ ms deadline$/
    );
    expect(events).toEqual([
      'create:modern-stdio:red',
      'run:modern-stdio:red',
      'close:modern-stdio:red',
    ]);
  });

  it('rejects cleanup proof when an aborted run remains pending after close', async () => {
    const events: string[] = [];
    const failure = verifySingleCase(dependencies(events, { runNeverSettles: true }), {
      caseTimeoutMs: 100,
      runTimeoutMs: 100,
    });

    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await expect(failure).rejects.toThrow(/cleanup both failed/i);
    expect(events).toContain('abort-cleanup:modern-stdio:red');
  });

  it('preserves a late non-abort run rejection with the deadline failure', async () => {
    const failure = verifySingleCase(
      dependencies([], { lateRunFailure: new Error('late run exploded') }),
      RESERVE_BUDGET
    );

    await expect(failure).rejects.toMatchObject({
      errors: [
        expect.any(McpLabRunnerDeadlineError),
        expect.objectContaining({ message: 'late run exploded' }),
      ],
    });
  });

  it('surfaces both primary and cleanup failures without starting the next phase', async () => {
    const events: string[] = [];
    const failure = verifySingleCase(
      dependencies(events, {
        cleanupFailure: new Error('cleanup exploded'),
        runFailure: new Error('run exploded'),
      })
    );

    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await expect(failure).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'run exploded' }),
        expect.objectContaining({ message: 'cleanup exploded' }),
      ],
    });
    expect(events).toEqual([
      'create:modern-stdio:red',
      'run:modern-stdio:red',
      'close:modern-stdio:red',
    ]);
  });

  it('rejects cleanup failure after a successful phase and emits no evidence', async () => {
    const events: string[] = [];
    await expect(
      verifySingleCase(dependencies(events, { cleanupFailure: new Error('cleanup exploded') }))
    ).rejects.toThrow('cleanup exploded');
    expect(events).toHaveLength(3);
  });

  it('rejects observed negotiation that disagrees with the canonical scenario', async () => {
    const events: string[] = [];
    await expect(
      verifySingleCase(
        dependencies(events, {
          mapObservation: (value) => ({
            ...value,
            negotiation: { era: 'legacy', revision: '2025-11-25' },
          }),
        })
      )
    ).rejects.toThrow(/modern.*2026-07-28/i);
    expect(events).toContain('close:modern-stdio:red');
  });

  it('treats reordered capabilities as the same negotiated set', async () => {
    const result = await verifySingleCase(
      dependencies([], {
        mapObservation: (value, phase) => ({
          ...value,
          capabilities:
            phase === 'green'
              ? ['tools', 'resources', 'prompts', 'completions']
              : ['completions', 'prompts', 'resources', 'tools'],
        }),
      }),
      { caseIds: ['modern-http-in-process'] }
    );

    expect(result).toHaveLength(1);
  });

  it('checks the whole-run deadline again before emitting final evidence', async () => {
    let now = 0;
    await expect(
      verifySingleCase(
        {
          createPhaseOwner(runnerCase, phase) {
            return {
              async close() {
                return { details: 'closed', verified: true };
              },
              async run() {
                if (phase === 'verification') {
                  now = 99;
                }
                return observation(runnerCase, phase);
              },
            };
          },
          now: () => now,
        },
        { caseTimeoutMs: 100, runTimeoutMs: 100 },
        {
          get maxArtifactBytes() {
            now = 100;
            return 1024;
          },
          readArtifactContent: () => new Uint8Array(),
        }
      )
    ).rejects.toThrow(/modern-stdio.*evidence.*100 ms/i);
  });

  it('shares one case budget across RED, GREEN, and verification', async () => {
    let now = 0;
    await expect(
      verifySingleCase(
        {
          createPhaseOwner(runnerCase, phase) {
            return {
              async close() {
                return { details: 'closed', verified: true };
              },
              async run() {
                now += 40;
                return observation(runnerCase, phase);
              },
            };
          },
          now: () => now,
        },
        { caseTimeoutMs: 100, runTimeoutMs: 1000 }
      )
    ).rejects.toThrow(/modern-stdio.*case.*100 ms/i);
  });
});
