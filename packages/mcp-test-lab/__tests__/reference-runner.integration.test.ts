import { describe, expect, it } from 'vitest';
import { createMcpLabReferenceRunnerDependencies } from '../src/reference-runner';
import { runMcpLabVerification } from '../src/runner';

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
    }
    expect(JSON.stringify(bundles)).not.toMatch(/bearer|access[_-]?token|client[_-]?secret/i);
  }, 30_000);

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
