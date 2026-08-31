import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  McpArtifactIntegrityError,
  verifyMcpEvidenceArtifactIntegrity,
} from '../src/evidence-artifact-integrity';
import { evidenceFixture } from './evidence-test-fixture';

const MAX_ARTIFACT_BYTES = 1024;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function evidenceWithArtifact(
  bytes: Uint8Array,
  artifact: { kind: 'log' | 'report' | 'screenshot' | 'trace'; reference: string }
) {
  const evidence = evidenceFixture();
  evidence.artifacts = [
    {
      ...artifact,
      sanitized: true,
      sha256: sha256(bytes),
    },
  ];
  return evidence;
}

describe('verifyMcpEvidenceArtifactIntegrity', () => {
  it('hashes original bytes, reads each artifact once, and fatally decodes text', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]);
    const evidence = evidenceWithArtifact(bytes, {
      kind: 'log',
      reference: 'artifacts/main.log',
    });
    const readArtifactContent = vi.fn(async () => bytes);

    const result = await verifyMcpEvidenceArtifactIntegrity(evidence, {
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      readArtifactContent,
    });

    expect(readArtifactContent).toHaveBeenCalledOnce();
    expect(readArtifactContent).toHaveBeenCalledWith('artifacts/main.log', MAX_ARTIFACT_BYTES);
    expect(result.artifacts).toEqual([
      {
        extractedText: 'a',
        kind: 'log',
        reference: 'artifacts/main.log',
        sha256: sha256(bytes),
      },
    ]);
  });

  it('rejects a digest that does not match the original bytes', async () => {
    const evidence = evidenceFixture();

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => new TextEncoder().encode('different bytes'),
      })
    ).rejects.toMatchObject({
      code: 'artifact_hash_mismatch',
      reference: 'artifacts/a.log',
    });
  });

  it('rejects malformed UTF-8 instead of replacing invalid bytes', async () => {
    const bytes = Uint8Array.from([0xc3, 0x28]);
    const evidence = evidenceWithArtifact(bytes, {
      kind: 'trace',
      reference: 'artifacts/session.trace',
    });

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => bytes,
      })
    ).rejects.toMatchObject({ code: 'artifact_decode_failed' });
  });

  it('requires screenshot extraction and gives the extractor exact bytes', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const evidence = evidenceWithArtifact(bytes, {
      kind: 'screenshot',
      reference: 'artifacts/window.png',
    });

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => bytes,
      })
    ).rejects.toMatchObject({ code: 'screenshot_extractor_missing' });

    const extractScreenshotText = vi.fn(async (received: Uint8Array) => {
      expect(received).toEqual(bytes);
      return 'Linear authorization required';
    });
    const extractScreenshotMetadata = vi.fn(async (received: Uint8Array) => {
      expect(received).toEqual(bytes);
      return 'Software=Brainstrike';
    });
    const result = await verifyMcpEvidenceArtifactIntegrity(evidence, {
      extractScreenshotMetadata,
      extractScreenshotText,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      readArtifactContent: async () => bytes,
    });

    expect(extractScreenshotText).toHaveBeenCalledOnce();
    expect(extractScreenshotMetadata).toHaveBeenCalledOnce();
    expect(result.artifacts[0]?.extractedText).toBe(
      'Linear authorization required\nSoftware=Brainstrike'
    );
  });

  it('rejects duplicate references before reading any artifact', async () => {
    const evidence = evidenceFixture();
    const artifact = evidence.artifacts[0];
    if (artifact === undefined) {
      throw new Error('Missing artifact fixture');
    }
    evidence.artifacts = [artifact, { ...artifact }];
    const readArtifactContent = vi.fn(async () => new Uint8Array());

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      })
    ).rejects.toThrow(/\$\.artifacts.*unique/i);
    expect(readArtifactContent).not.toHaveBeenCalled();
  });

  it('never exposes artifact content through dependency failures', async () => {
    const secret = 'linear_oauth_secret_should_not_escape';
    const evidence = evidenceFixture();

    let caught: unknown;
    try {
      await verifyMcpEvidenceArtifactIntegrity(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => {
          throw new Error(secret);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(McpArtifactIntegrityError);
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it('sanitizes screenshot extractor failures', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const secret = 'screenshot_contained_a_private_token';
    const evidence = evidenceWithArtifact(bytes, {
      kind: 'screenshot',
      reference: 'artifacts/window.png',
    });

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, {
        extractScreenshotMetadata: async () => '',
        extractScreenshotText: async () => {
          throw new Error(secret);
        },
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => bytes,
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(McpArtifactIntegrityError);
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      return true;
    });
  });

  it('rejects non-byte reader results without reflecting their contents', async () => {
    const evidence = evidenceFixture();

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => 'artifact text' as unknown as Uint8Array,
      })
    ).rejects.toMatchObject({ code: 'invalid_artifact_content' });
  });

  it('copies Buffer and reader-controlled slice inputs before hashing or extraction', async () => {
    const source = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const original = Uint8Array.from(source);
    Object.defineProperty(source, 'slice', {
      value: () => {
        throw new Error('reader-controlled slice must not run');
      },
    });
    const evidence = evidenceWithArtifact(original, {
      kind: 'screenshot',
      reference: 'artifacts/window.png',
    });

    const result = await verifyMcpEvidenceArtifactIntegrity(evidence, {
      extractScreenshotMetadata: async (received) => {
        expect(received).toEqual(original);
        return '';
      },
      extractScreenshotText: async (received) => {
        source.fill(0);
        expect(received).toEqual(original);
        expect(received.buffer).not.toBe(source.buffer);
        return 'window';
      },
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      readArtifactContent: async () => source,
    });

    expect(result.artifacts[0]?.extractedText).toBe('window\n');
  });

  it('requires and sanitizes screenshot metadata extraction', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const evidence = evidenceWithArtifact(bytes, {
      kind: 'screenshot',
      reference: 'artifacts/window.png',
    });
    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, {
        extractScreenshotText: async () => 'window',
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => bytes,
      })
    ).rejects.toMatchObject({ code: 'screenshot_metadata_extractor_missing' });
    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, {
        extractScreenshotMetadata: async () => {
          throw new Error('secret metadata');
        },
        extractScreenshotText: async () => 'window',
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => bytes,
      })
    ).rejects.toMatchObject({ code: 'screenshot_metadata_extraction_failed' });
  });

  it('passes and enforces an explicit artifact byte limit', async () => {
    const bytes = new TextEncoder().encode('oversized');
    const evidence = evidenceWithArtifact(bytes, { kind: 'log', reference: 'artifacts/a.log' });
    const readArtifactContent = vi.fn(async () => bytes);

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidence, { maxArtifactBytes: 4, readArtifactContent })
    ).rejects.toMatchObject({ code: 'artifact_too_large' });
    expect(readArtifactContent).toHaveBeenCalledWith('artifacts/a.log', 4);
  });

  it('rejects an invalid artifact byte limit before reading', async () => {
    const readArtifactContent = vi.fn(async () => new Uint8Array());

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidenceFixture(), {
        maxArtifactBytes: 0,
        readArtifactContent,
      })
    ).rejects.toMatchObject({ code: 'invalid_artifact_limit' });
    expect(readArtifactContent).not.toHaveBeenCalled();
  });

  it('preserves only a bounded filesystem error code', async () => {
    const error = Object.assign(new Error('private path and artifact content'), { code: 'ENOENT' });

    await expect(
      verifyMcpEvidenceArtifactIntegrity(evidenceFixture(), {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => {
          throw error;
        },
      })
    ).rejects.toSatisfy((caught: unknown) => {
      expect(String(caught)).toContain('ENOENT');
      expect(String(caught)).not.toContain(error.message);
      return true;
    });
  });
});
