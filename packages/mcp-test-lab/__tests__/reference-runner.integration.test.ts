import { describe, expect, it } from 'vitest';
import { mcpEvidenceCapabilitiesFor } from '../src/evidence-schema';
import { startMcpLabScenario } from '../src/lab';
import { createMcpLabReferenceRunnerDependencies } from '../src/reference-runner';
import { runMcpLabVerification } from '../src/runner';
import { MCP_LAB_RUNNER_CASES } from '../src/runner-manifest';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const COMMAND = 'pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json';
const integrity = {
  maxArtifactBytes: 1024,
  readArtifactContent: () => new Uint8Array(),
} as const;

describe('MCP official reference runner', () => {
  it('executes every representative case through real RED, GREEN, verification, and cleanup', async () => {
    const bundles = await runMcpLabVerification(
      {
        blockers: [],
        command: COMMAND,
        git: { commitSha: SHA, workspaceState: 'clean' },
        selection: { profile: 'pr' },
        ticket: 'BST-1496',
      },
      createMcpLabReferenceRunnerDependencies(),
      integrity
    );

    expect(bundles.map(({ schema }) => schema.scenarioId)).toEqual([
      'modern-reference',
      'legacy-reference',
      'oauth-reference',
      'stdio-reference',
      'tasks-reference',
      'apps-reference',
    ]);
    const caseIds = [
      'modern-http-in-process',
      'legacy-http-loopback',
      'oauth-http-loopback',
      'modern-stdio',
      'modern-tasks-in-process',
      'modern-apps-in-process',
    ];
    const redSuffixes: Readonly<Record<string, string>> = {
      'apps-reference': 'missing-resource-rejection',
      'modern-reference': 'intentional-tool-error',
      'tasks-reference': 'missing-task-rejection',
    };
    const redSuffix = (scenarioId: string): string =>
      redSuffixes[scenarioId] ?? 'missing-tool-rejection';
    for (const [index, { schema }] of bundles.entries()) {
      expect(schema.commands).toEqual([
        expect.objectContaining({
          exitStatus: 1,
          phase: 'red',
          tests: { failed: 1, passed: 0, skipped: 0, total: 1 },
        }),
        expect.objectContaining({
          exitStatus: 0,
          phase: 'green',
          tests: { failed: 0, passed: 1, skipped: 0, total: 1 },
        }),
        expect.objectContaining({
          exitStatus: 0,
          phase: 'verification',
          tests: { failed: 0, passed: 1, skipped: 0, total: 1 },
        }),
      ]);
      expect(schema.cleanup).toMatchObject({ exitStatus: 0, verified: true });
      expect(schema.cleanup.command).toBe(COMMAND);
      expect(schema.commands.every(({ command }) => command === COMMAND)).toBe(true);
      expect(schema.correlationIds).toHaveLength(3);
      expect(schema.correlationIds[0]).toBe(
        `${caseIds[index]}-red-${redSuffix(schema.scenarioId)}`
      );
      expect(schema.negotiation.capabilities).toEqual(
        mcpEvidenceCapabilitiesFor(schema.scenarioId)
      );
    }
    expect(JSON.stringify(bundles)).not.toMatch(/bearer|access[_-]?token|client[_-]?secret/i);
  }, 30_000);

  it('waits for an aborted startup allocation and closes the resulting lab', async () => {
    let releaseStart: () => void = () => {
      throw new Error('reference runner race fixture did not initialize');
    };
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runnerCase = MCP_LAB_RUNNER_CASES[0];
    const dependencies = createMcpLabReferenceRunnerDependencies({
      async startCase() {
        await startGate;
        return startMcpLabScenario('modern-reference', { execution: 'in-process' });
      },
    });
    const owner = dependencies.createPhaseOwner(runnerCase, 'green');
    const controller = new AbortController();
    const running = owner.run(controller.signal);
    await expect(owner.run(controller.signal)).rejects.toThrow(/already ran/i);
    controller.abort();
    const cleanup = owner.close(new AbortController().signal);

    await expect(Promise.race([cleanup, Promise.resolve('pending')])).resolves.toBe('pending');
    releaseStart();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(await cleanup).toEqual({ details: 'closed listeners=0 stdio=0', verified: true });
  });

  it('executes the exhaustive-only HTTP topologies through the same owner', async () => {
    const bundles = await runMcpLabVerification(
      {
        blockers: [],
        command: COMMAND.replace('pr', 'exhaustive'),
        git: { commitSha: SHA, workspaceState: 'clean' },
        selection: {
          caseIds: [
            'modern-http-loopback',
            'legacy-http-in-process',
            'modern-tasks-loopback',
            'modern-apps-loopback',
          ],
          profile: 'exhaustive',
        },
        ticket: 'BST-1496',
      },
      createMcpLabReferenceRunnerDependencies(),
      integrity
    );

    expect(bundles.map(({ schema }) => schema.scenarioId)).toEqual([
      'modern-reference',
      'legacy-reference',
      'tasks-reference',
      'apps-reference',
    ]);
    expect(bundles.every(({ schema }) => schema.cleanup.verified)).toBe(true);
  }, 30_000);
});
