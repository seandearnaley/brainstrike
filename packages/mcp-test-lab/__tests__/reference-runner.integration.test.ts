import { describe, expect, it } from 'vitest';
import { startMcpLabScenario } from '../src/lab';
import { createMcpLabReferenceRunnerDependencies } from '../src/reference-runner';
import { runMcpLabVerification } from '../src/runner';
import { MCP_LAB_RUNNER_CASES } from '../src/runner-manifest';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const COMMAND = 'pnpm --filter @brainstrike/mcp-test-lab verify -- --profile pr';
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
      'modern-http-in-process',
      'legacy-http-loopback',
      'oauth-http-loopback',
      'modern-stdio',
    ]);
    for (const { schema } of bundles) {
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
      expect(schema.correlationIds).toHaveLength(3);
      expect(schema.negotiation.capabilities).toEqual(['tools']);
    }
    expect(JSON.stringify(bundles)).not.toMatch(/bearer|access[_-]?token|client[_-]?secret/i);
  }, 30_000);

  it('waits for an aborted startup allocation and closes the resulting lab', async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runnerCase = MCP_LAB_RUNNER_CASES.find(({ id }) => id === 'modern-http-in-process');
    if (!(runnerCase && releaseStart)) {
      throw new Error('reference runner race fixture is unavailable');
    }
    const dependencies = createMcpLabReferenceRunnerDependencies({
      async startCase() {
        await startGate;
        return startMcpLabScenario('modern-reference', { execution: 'in-process' });
      },
    });
    const owner = dependencies.createPhaseOwner(runnerCase, 'green');
    const controller = new AbortController();
    const running = owner.run(controller.signal);
    controller.abort();
    const cleanup = owner.close();
    let cleanupSettled = false;
    void cleanup.finally(() => {
      cleanupSettled = true;
    });

    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    releaseStart();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(cleanup).resolves.toEqual({
      details: 'closed listeners=0 stdio=0',
      verified: true,
    });
  });

  it('executes the exhaustive-only HTTP topologies through the same owner', async () => {
    const bundles = await runMcpLabVerification(
      {
        blockers: [],
        command: COMMAND.replace('pr', 'exhaustive'),
        git: { commitSha: SHA, workspaceState: 'clean' },
        selection: {
          caseIds: ['modern-http-loopback', 'legacy-http-in-process'],
          profile: 'exhaustive',
        },
        ticket: 'BST-1496',
      },
      createMcpLabReferenceRunnerDependencies(),
      integrity
    );

    expect(bundles.map(({ schema }) => schema.scenarioId)).toEqual([
      'modern-http-loopback',
      'legacy-http-in-process',
    ]);
    expect(bundles.every(({ schema }) => schema.cleanup.verified)).toBe(true);
  }, 30_000);
});
