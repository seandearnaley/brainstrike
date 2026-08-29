import { describe, expect, it, vi } from 'vitest';
import {
  type McpLabRunnerCaseObservation,
  type McpLabRunnerDependencies,
  type McpLabRunnerPhase,
  type McpLabVerificationInput,
  runMcpLabVerification,
} from '../src/runner';
import type { McpLabRunnerCase, McpLabRunnerProfile } from '../src/runner-manifest';

const COMMAND = 'pnpm --filter @brainstrike/mcp-test-lab verify -- --profile pr';

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
    capabilities: ['tools'],
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
    readonly runFailure?: Error;
    readonly runNeverSettles?: boolean;
  } = {}
): McpLabRunnerDependencies {
  return {
    createPhaseOwner(runnerCase, phase) {
      events.push(`create:${runnerCase.id}:${phase}`);
      return {
        async close() {
          events.push(`close:${runnerCase.id}:${phase}`);
          if (options.cleanupFailure) {
            throw options.cleanupFailure;
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
          return observation(runnerCase, phase);
        },
      };
    },
    now: () => performance.now(),
  };
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
      'modern-http-in-process',
      'modern-stdio',
    ]);
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
    expect(events).toEqual([
      'create:modern-http-in-process:red',
      'run:modern-http-in-process:red',
      'close:modern-http-in-process:red',
      'create:modern-http-in-process:green',
      'run:modern-http-in-process:green',
      'close:modern-http-in-process:green',
      'create:modern-http-in-process:verification',
      'run:modern-http-in-process:verification',
      'close:modern-http-in-process:verification',
      'create:modern-stdio:red',
      'run:modern-stdio:red',
      'close:modern-stdio:red',
      'create:modern-stdio:green',
      'run:modern-stdio:green',
      'close:modern-stdio:green',
      'create:modern-stdio:verification',
      'run:modern-stdio:verification',
      'close:modern-stdio:verification',
    ]);
    expect(readArtifactContent).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]?.schema)).toBe(true);
  });

  it('aborts a hanging phase at its case deadline and still closes its owner', async () => {
    const events: string[] = [];
    await expect(
      runMcpLabVerification(
        input('pr', {
          selection: {
            caseIds: ['modern-stdio'],
            caseTimeoutMs: 100,
            profile: 'pr',
            runTimeoutMs: 100,
          },
        }),
        dependencies(events, { runNeverSettles: true }),
        { maxArtifactBytes: 1024, readArtifactContent: () => new Uint8Array() }
      )
    ).rejects.toThrow(/modern-stdio.*red.*100 ms/i);
    expect(events).toEqual([
      'create:modern-stdio:red',
      'run:modern-stdio:red',
      'close:modern-stdio:red',
    ]);
  });

  it('surfaces both primary and cleanup failures without starting the next phase', async () => {
    const events: string[] = [];
    const failure = runMcpLabVerification(
      input('pr', {
        selection: { caseIds: ['modern-stdio'], profile: 'pr' },
      }),
      dependencies(events, {
        cleanupFailure: new Error('cleanup exploded'),
        runFailure: new Error('run exploded'),
      }),
      { maxArtifactBytes: 1024, readArtifactContent: () => new Uint8Array() }
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
      runMcpLabVerification(
        input('pr', { selection: { caseIds: ['modern-stdio'], profile: 'pr' } }),
        dependencies(events, { cleanupFailure: new Error('cleanup exploded') }),
        { maxArtifactBytes: 1024, readArtifactContent: () => new Uint8Array() }
      )
    ).rejects.toThrow('cleanup exploded');
    expect(events).toHaveLength(3);
  });

  it('rejects observed negotiation that disagrees with the canonical scenario', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const createPhaseOwner = deps.createPhaseOwner;
    await expect(
      runMcpLabVerification(
        input('pr', { selection: { caseIds: ['modern-stdio'], profile: 'pr' } }),
        {
          ...deps,
          createPhaseOwner(runnerCase, phase) {
            const owner = createPhaseOwner(runnerCase, phase);
            return {
              close: owner.close,
              async run(signal) {
                const value = await owner.run(signal);
                return {
                  ...value,
                  negotiation: { era: 'legacy' as const, revision: '2025-11-25' },
                };
              },
            };
          },
        },
        { maxArtifactBytes: 1024, readArtifactContent: () => new Uint8Array() }
      )
    ).rejects.toThrow(/modern.*2026-07-28/i);
    expect(events).toContain('close:modern-stdio:red');
  });

  it('treats reordered capabilities as the same negotiated set', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const createPhaseOwner = deps.createPhaseOwner;
    const result = await runMcpLabVerification(
      input('pr', { selection: { caseIds: ['modern-stdio'], profile: 'pr' } }),
      {
        ...deps,
        createPhaseOwner(runnerCase, phase) {
          const owner = createPhaseOwner(runnerCase, phase);
          return {
            close: owner.close,
            async run(signal) {
              return {
                ...(await owner.run(signal)),
                capabilities: phase === 'green' ? ['resources', 'tools'] : ['tools', 'resources'],
              };
            },
          };
        },
      },
      { maxArtifactBytes: 1024, readArtifactContent: () => new Uint8Array() }
    );

    expect(result).toHaveLength(1);
  });

  it('caps cleanup at the remaining whole-run budget', async () => {
    let now = 0;
    const failure = runMcpLabVerification(
      input('pr', {
        selection: {
          caseIds: ['modern-stdio'],
          caseTimeoutMs: 100,
          profile: 'pr',
          runTimeoutMs: 100,
        },
      }),
      {
        createPhaseOwner(runnerCase, phase) {
          return {
            async close() {
              await new Promise(() => undefined);
              return { details: 'unreachable', verified: true };
            },
            async run() {
              now = 90;
              return observation(runnerCase, phase);
            },
          };
        },
        now: () => now,
      },
      { maxArtifactBytes: 1024, readArtifactContent: () => new Uint8Array() }
    );

    await expect(failure).rejects.toThrow(/modern-stdio.*red.*cleanup.*10 ms/i);
  });

  it('checks the whole-run deadline again before emitting final evidence', async () => {
    let now = 0;
    await expect(
      runMcpLabVerification(
        input('pr', {
          selection: {
            caseIds: ['modern-stdio'],
            caseTimeoutMs: 100,
            profile: 'pr',
            runTimeoutMs: 100,
          },
        }),
        {
          createPhaseOwner(runnerCase, phase) {
            return {
              async close() {
                if (phase === 'verification') {
                  now = 100;
                }
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
        { maxArtifactBytes: 1024, readArtifactContent: () => new Uint8Array() }
      )
    ).rejects.toThrow(/modern-stdio.*evidence.*100 ms/i);
  });
});
