import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  type McpArtifactKind,
  McpEvidenceSecretError,
  verifyMcpEvidenceBundle,
} from '../src/evidence';
import { evidenceFixture } from './evidence-test-fixture';

const MAX_ARTIFACT_BYTES = 1024;
const SECRET = ['oauth', '_private', '_credential'].join('');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function evidenceWithArtifact(kind: McpArtifactKind, bytes: Uint8Array) {
  const extensionByKind: Readonly<Record<McpArtifactKind, string>> = {
    log: 'log',
    report: 'html',
    screenshot: 'png',
    trace: 'trace',
  };
  const evidence = evidenceFixture();
  evidence.artifacts = [
    {
      kind,
      reference: `artifacts/session.${extensionByKind[kind]}`,
      sanitized: true,
      sha256: sha256(bytes),
    },
  ];
  return evidence;
}

describe('verifyMcpEvidenceBundle secret sanitization', () => {
  it('rejects a credential-bearing renderer URL in desktop CDT metadata', async () => {
    const bytes = new TextEncoder().encode('safe artifact');
    const evidence = evidenceWithArtifact('log', bytes);
    evidence.artifacts.push({
      kind: 'screenshot',
      reference: 'artifacts/window.png',
      sanitized: true,
      sha256: sha256(bytes),
    });
    evidence.desktop = {
      app: {
        bundleId: 'com.brainstrike.desktop.agent-debug',
        title: 'BrainStrike Agent Debug',
      },
      cdt: {
        endpoint: 'http://127.0.0.1:9222',
        inspected: true,
        rendererUrl: `http://localhost:5173/oauth/callback?code=${SECRET}`,
        targetTitle: 'BrainStrike Agent Debug',
      },
      electronE2e: {
        command: 'pnpm --filter @brainstrike/desktop test:e2e',
        exitStatus: 0,
        tests: { failed: 0, passed: 1, skipped: 0, total: 1 },
      },
      matrix: [
        'settings-connect',
        'oauth-browser-return',
        'assistant-call',
        'cancellation',
        'restart-reconnect',
        'config-change',
        'concurrent-runs',
        'disconnect-cleanup',
      ].map((id) => ({
        artifactReferences: ['artifacts/session.log', 'artifacts/window.png'],
        blockerCode: null,
        id,
        status: 'passed',
      })),
      profile: { isolated: true, userDataDirectory: 'artifacts/profile' },
      required: true,
      secretScan: {
        artifactReferences: ['artifacts/session.log', 'artifacts/window.png'],
        command: 'pnpm secret-scan artifacts/session.log',
        exitStatus: 0,
        verified: true,
      },
    };
    const readArtifactContent = vi.fn(async () => bytes);

    await expect(
      verifyMcpEvidenceBundle(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      })
    ).rejects.toMatchObject({
      issue: {
        code: 'secret_detected',
        kind: 'credential-bearing-url',
        path: '$.desktop.cdt.rendererUrl',
      },
    });
    expect(readArtifactContent).not.toHaveBeenCalled();
  });
  it('rejects credential-bearing artifact references before dependency I/O', async () => {
    const bytes = new TextEncoder().encode('safe artifact');
    const evidence = evidenceWithArtifact('log', bytes);
    evidence.artifacts[0]!.reference = `artifacts/client_secret=${SECRET}.log`;
    const readArtifactContent = vi.fn(async () => bytes);
    let caught: unknown;

    try {
      await verifyMcpEvidenceBundle(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(McpEvidenceSecretError);
    expect(caught).toMatchObject({
      issue: {
        code: 'secret_detected',
        path: '$.artifacts[0].reference',
      },
    });
    expect(readArtifactContent).not.toHaveBeenCalled();
    expect(String(caught)).not.toContain(SECRET);
    expect(JSON.stringify(caught)).not.toContain(SECRET);
  });

  it('rejects percent-encoded credential references before dependency I/O', async () => {
    const bytes = new TextEncoder().encode('safe artifact');
    const evidence = evidenceWithArtifact('log', bytes);
    evidence.artifacts[0]!.reference = `artifacts/client_secret%253D${SECRET}.log`;
    const readArtifactContent = vi.fn(async () => bytes);

    await expect(
      verifyMcpEvidenceBundle(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      })
    ).rejects.toMatchObject({
      issue: {
        code: 'secret_detected',
        path: '$.artifacts[0].reference',
      },
    });
    expect(readArtifactContent).not.toHaveBeenCalled();
  });

  it('rejects secrets in closed-schema metadata without trusting sanitized flags', async () => {
    const bytes = new TextEncoder().encode('safe artifact');
    const evidence = evidenceWithArtifact('log', bytes);
    evidence.cleanup.details = `client_secret=${SECRET}`;
    const readArtifactContent = vi.fn(async () => bytes);

    await expect(
      verifyMcpEvidenceBundle(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      })
    ).rejects.toMatchObject({
      issue: {
        code: 'secret_detected',
        kind: 'credential-assignment',
        path: '$.cleanup.details',
      },
    });
    expect(readArtifactContent).not.toHaveBeenCalled();
  });

  it.each(['log', 'report', 'trace'] as const)(
    'rejects decoded %s artifact text after one exact-byte read',
    async (kind) => {
      const bytes = new TextEncoder().encode(`NPM_TOKEN=npm_${'a'.repeat(36)}`);
      const evidence = evidenceWithArtifact(kind, bytes);
      const readArtifactContent = vi.fn(async () => bytes);

      await expect(
        verifyMcpEvidenceBundle(evidence, {
          maxArtifactBytes: MAX_ARTIFACT_BYTES,
          readArtifactContent,
        })
      ).rejects.toMatchObject({
        issue: {
          code: 'secret_detected',
          kind: 'credential-assignment',
          path: '$.artifacts[0].content',
        },
      });
      expect(readArtifactContent).toHaveBeenCalledOnce();
    }
  );

  it('rejects entity-encoded structured credentials in extracted screenshots', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const evidence = evidenceWithArtifact('screenshot', bytes);
    const readArtifactContent = vi.fn(async () => bytes);
    const extractScreenshotText = vi.fn(
      async () => `screen: &#123;&quot;access_token&quot;:&quot;${SECRET}&quot;&#125;`
    );

    await expect(
      verifyMcpEvidenceBundle(evidence, {
        extractScreenshotMetadata: async () => '',
        extractScreenshotText,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      })
    ).rejects.toMatchObject({
      issue: {
        code: 'secret_detected',
        kind: 'credential-assignment',
        path: '$.artifacts[0].content',
      },
    });
    expect(readArtifactContent).toHaveBeenCalledOnce();
    expect(extractScreenshotText).toHaveBeenCalledOnce();
  });

  it('rejects credentials embedded in screenshot metadata', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const evidence = evidenceWithArtifact('screenshot', bytes);
    await expect(
      verifyMcpEvidenceBundle(evidence, {
        extractScreenshotMetadata: async () => `access_token=${SECRET}`,
        extractScreenshotText: async () => 'safe pixels',
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => bytes,
      })
    ).rejects.toMatchObject({
      issue: { code: 'secret_detected', path: '$.artifacts[0].content' },
    });
  });

  it('does not expose secret values in errors or enumerable issue data', async () => {
    const bytes = new TextEncoder().encode(`authorization: Bearer ${SECRET}`);
    const evidence = evidenceWithArtifact('log', bytes);
    let caught: unknown;

    try {
      await verifyMcpEvidenceBundle(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => bytes,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(McpEvidenceSecretError);
    expect(caught).toMatchObject({
      issue: {
        code: 'secret_detected',
        index: 0,
        kind: 'bearer-token',
        path: '$.artifacts[0].content',
      },
    });
    expect(String(caught)).not.toContain(SECRET);
    expect(JSON.stringify(caught)).not.toContain(SECRET);
  });

  it('never copies artifact-derived JSON keys into diagnostics', async () => {
    const untrustedKey = 'prod-db-admin@internal.example';
    const text = JSON.stringify({
      [untrustedKey]: JSON.stringify({ access_token: SECRET }),
    });
    const bytes = new TextEncoder().encode(text);
    const evidence = evidenceWithArtifact('log', bytes);
    let caught: unknown;

    try {
      await verifyMcpEvidenceBundle(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent: async () => bytes,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(McpEvidenceSecretError);
    expect((caught as McpEvidenceSecretError).issue.path).toMatch(
      /^\$\.artifacts\[0\]\.content\{0\}\.value/u
    );
    expect(String(caught)).not.toContain(untrustedKey);
    expect(JSON.stringify(caught)).not.toContain(untrustedKey);
  });

  it('stops artifact I/O immediately after rejected extracted text', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const evidence = evidenceWithArtifact('screenshot', bytes);
    evidence.artifacts = Array.from({ length: 3 }, (_, index) => ({
      kind: 'screenshot' as const,
      reference: `artifacts/window-${index}.png`,
      sanitized: true as const,
      sha256: sha256(bytes),
    }));
    const readArtifactContent = vi.fn(async () => bytes);
    const extractScreenshotText = vi.fn(async (_received: Uint8Array, reference: string) => {
      if (reference.endsWith('-1.png')) {
        return `authorization: Bearer ${SECRET}`;
      }
      return 'safe screenshot';
    });

    await expect(
      verifyMcpEvidenceBundle(evidence, {
        extractScreenshotMetadata: async () => '',
        extractScreenshotText,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      })
    ).rejects.toMatchObject({ issue: { path: '$.artifacts[1].content' } });
    expect(readArtifactContent).toHaveBeenCalledTimes(2);
    expect(extractScreenshotText).toHaveBeenCalledTimes(2);
    expect(readArtifactContent).not.toHaveBeenCalledWith(
      'artifacts/window-2.png',
      expect.anything()
    );
  });

  it('enforces candidate budgets across all artifacts in one bundle', async () => {
    const text = `INFO ${Array.from({ length: 64 }, () => '{}').join(' ')}`;
    const bytes = new TextEncoder().encode(text);
    const evidence = evidenceWithArtifact('log', bytes);
    evidence.artifacts = Array.from({ length: 6 }, (_, index) => ({
      kind: 'log' as const,
      reference: `artifacts/session-${index}.log`,
      sanitized: true as const,
      sha256: sha256(bytes),
    }));
    const readArtifactContent = vi.fn(async () => bytes);

    await expect(
      verifyMcpEvidenceBundle(evidence, {
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        readArtifactContent,
      })
    ).rejects.toThrowError(/candidate count exceeds/i);
    expect(readArtifactContent).toHaveBeenCalledTimes(5);
    expect(readArtifactContent).not.toHaveBeenCalledWith(
      'artifacts/session-5.log',
      expect.anything()
    );
  });

  it('preserves the immutable facade for sanitized metadata and artifacts', async () => {
    const bytes = new TextEncoder().encode('authorization: not-required');
    const evidence = evidenceWithArtifact('report', bytes);

    const bundle = await verifyMcpEvidenceBundle(evidence, {
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      readArtifactContent: async () => bytes,
    });

    expect(bundle.artifacts[0]?.extractedText).toBe('authorization: not-required');
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.schema)).toBe(true);
    expect(Object.isFrozen(bundle.artifacts[0])).toBe(true);
  });
});
