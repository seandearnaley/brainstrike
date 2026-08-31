import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as evidenceApi from '../src/evidence';
import { evidenceFixture } from './evidence-test-fixture';

const MAX_ARTIFACT_BYTES = 1024;

function assertDeeplyFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    assertDeeplyFrozen(Reflect.get(value, key));
  }
}

describe('verifyMcpEvidenceBundle', () => {
  it('returns a deeply frozen, detached exact-byte bundle', async () => {
    const bytes = new TextEncoder().encode('sanitized log');
    const evidence = evidenceFixture();
    const artifact = evidence.artifacts[0];
    if (artifact === undefined) {
      throw new Error('Missing artifact fixture');
    }
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex');

    const bundle = await evidenceApi.verifyMcpEvidenceBundle(evidence, {
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      readArtifactContent: async () => bytes,
    });

    assertDeeplyFrozen(bundle);
    evidence.ticket = 'BST-9999';
    evidence.negotiation.capabilities[0] = 'changed';
    bytes.fill(0);
    expect(bundle.schema.ticket).toBe('BST-1484');
    expect(bundle.schema.negotiation.capabilities).toEqual([
      'completions',
      'prompts',
      'resources',
      'tools',
    ]);
    expect(bundle.artifacts[0]?.extractedText).toBe('sanitized log');
    expect(Reflect.set(bundle.schema, 'ticket', 'BST-9999')).toBe(false);
    expect(bundle.schema.ticket).toBe('BST-1484');
  });

  it('validates the closed schema before invoking artifact dependencies', async () => {
    const evidence = { ...evidenceFixture(), extra: true };
    const readArtifactContent = vi.fn(async () => new Uint8Array());

    await expect(
      evidenceApi.verifyMcpEvidenceBundle(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      })
    ).rejects.toThrow(/unknown field/i);
    expect(readArtifactContent).not.toHaveBeenCalled();
  });

  it('does not expose mutable lower-level verifier entrypoints', () => {
    expect(evidenceApi).not.toHaveProperty('verifyMcpEvidenceArtifactIntegrity');
    expect(evidenceApi).not.toHaveProperty('parseMcpEvidenceSchema');
  });
});
