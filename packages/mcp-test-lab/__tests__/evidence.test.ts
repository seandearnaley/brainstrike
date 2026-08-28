import { describe, expect, it } from 'vitest';
import {
  MCP_EVIDENCE_SCHEMA_VERSION,
  type McpEvidenceBundle,
  McpEvidenceValidationError,
  parseMcpEvidenceBundle,
  scanEvidenceTextForSecrets,
} from '../src/evidence';

const VALID_BUNDLE = {
  artifacts: [
    {
      kind: 'log',
      reference: 'artifacts/main-process.ndjson',
      sanitized: true,
      sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  ],
  blockers: [],
  cleanup: {
    command: 'pnpm mcp-lab cleanup modern-http-tools-and-resources',
    details: 'All listeners and child processes exited.',
    exitStatus: 0,
    verified: true,
  },
  commands: [
    {
      command: 'pnpm vitest run evidence.test.ts',
      exitStatus: 1,
      phase: 'red',
      tests: { failed: 1, passed: 0, skipped: 0, total: 1 },
    },
    {
      command: 'pnpm vitest run evidence.test.ts',
      exitStatus: 0,
      phase: 'green',
      tests: { failed: 0, passed: 1, skipped: 0, total: 1 },
    },
  ],
  correlationIds: ['mcp-op-019d47b0-0280-7000-8000-000000000001'],
  git: {
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    workspaceState: 'clean',
  },
  negotiation: {
    capabilities: ['prompts', 'resources', 'tools'],
    era: 'modern',
    revision: '2026-07-28',
  },
  scenarioId: 'modern-http-tools-and-resources',
  schemaVersion: '1.0.0',
  ticket: 'BST-1475',
  versions: {
    conformance: {
      package: '@modelcontextprotocol/conformance',
      version: '0.2.0-alpha.10',
    },
    sdk: {
      package: '@modelcontextprotocol/client',
      version: '2.0.0',
    },
    spec: '2026-07-28',
  },
} as const satisfies McpEvidenceBundle;

describe('parseMcpEvidenceBundle', () => {
  it('accepts a complete exact-head MCP scenario evidence bundle', () => {
    expect(MCP_EVIDENCE_SCHEMA_VERSION).toBe('1.0.0');
    expect(parseMcpEvidenceBundle(VALID_BUNDLE)).toEqual(VALID_BUNDLE);
  });

  it('rejects missing and unknown fields at every strict object boundary', () => {
    const missingTicket = {
      artifacts: VALID_BUNDLE.artifacts,
      blockers: VALID_BUNDLE.blockers,
      cleanup: VALID_BUNDLE.cleanup,
      commands: VALID_BUNDLE.commands,
      correlationIds: VALID_BUNDLE.correlationIds,
      git: VALID_BUNDLE.git,
      negotiation: VALID_BUNDLE.negotiation,
      scenarioId: VALID_BUNDLE.scenarioId,
      schemaVersion: VALID_BUNDLE.schemaVersion,
      versions: VALID_BUNDLE.versions,
    };
    const unknownRoot = { ...VALID_BUNDLE, generatedAt: '2026-08-28T17:00:00Z' };
    const unknownNested = {
      ...VALID_BUNDLE,
      git: { ...VALID_BUNDLE.git, branch: 'codex/bst-1475' },
    };

    expect(() => parseMcpEvidenceBundle(missingTicket)).toThrowError(/ticket.*required/i);
    expect(() => parseMcpEvidenceBundle(unknownRoot)).toThrowError(/generatedAt.*unknown/i);
    expect(() => parseMcpEvidenceBundle(unknownNested)).toThrowError(/git\.branch.*unknown/i);
  });

  it('requires exact identifiers, versions, hashes, counts, and explicit cleanup proof', () => {
    const malformedBundles = [
      { ...VALID_BUNDLE, schemaVersion: 'latest' },
      { ...VALID_BUNDLE, ticket: '1475' },
      {
        ...VALID_BUNDLE,
        git: { ...VALID_BUNDLE.git, commitSha: '0123456' },
      },
      {
        ...VALID_BUNDLE,
        versions: {
          ...VALID_BUNDLE.versions,
          sdk: { ...VALID_BUNDLE.versions.sdk, version: '^2.0.0' },
        },
      },
      {
        ...VALID_BUNDLE,
        commands: [
          VALID_BUNDLE.commands[0],
          {
            ...VALID_BUNDLE.commands[1],
            tests: { failed: 0, passed: 1, skipped: 0, total: 2 },
          },
        ],
      },
      {
        ...VALID_BUNDLE,
        artifacts: [{ ...VALID_BUNDLE.artifacts[0], sanitized: false }],
      },
      {
        ...VALID_BUNDLE,
        artifacts: [{ ...VALID_BUNDLE.artifacts[0], reference: '../raw.log' }],
      },
      {
        ...VALID_BUNDLE,
        cleanup: { ...VALID_BUNDLE.cleanup, verified: false },
      },
    ];

    for (const malformed of malformedBundles) {
      expect(() => parseMcpEvidenceBundle(malformed)).toThrow(McpEvidenceValidationError);
    }
  });

  it('requires RED proof before successful GREEN proof and permits verification only afterward', () => {
    const greenBeforeRed = {
      ...VALID_BUNDLE,
      commands: [VALID_BUNDLE.commands[1], VALID_BUNDLE.commands[0]],
    };
    const passingRed = {
      ...VALID_BUNDLE,
      commands: [{ ...VALID_BUNDLE.commands[0], exitStatus: 0 }, VALID_BUNDLE.commands[1]],
    };
    const failingGreen = {
      ...VALID_BUNDLE,
      commands: [VALID_BUNDLE.commands[0], { ...VALID_BUNDLE.commands[1], exitStatus: 1 }],
    };
    const verificationBeforeGreen = {
      ...VALID_BUNDLE,
      commands: [
        VALID_BUNDLE.commands[0],
        {
          ...VALID_BUNDLE.commands[1],
          phase: 'verification',
          tests: { failed: 0, passed: 0, skipped: 0, total: 0 },
        },
        VALID_BUNDLE.commands[1],
      ],
    };

    expect(() => parseMcpEvidenceBundle(greenBeforeRed)).toThrowError(/RED.*first/i);
    expect(() => parseMcpEvidenceBundle(passingRed)).toThrowError(/RED.*non-zero/i);
    expect(() => parseMcpEvidenceBundle(failingGreen)).toThrowError(/GREEN.*zero/i);
    expect(() => parseMcpEvidenceBundle(verificationBeforeGreen)).toThrowError(
      /verification.*GREEN/i
    );
  });

  it('requires observed protocol identity, unique capabilities, and correlation IDs', () => {
    expect(() =>
      parseMcpEvidenceBundle({
        ...VALID_BUNDLE,
        negotiation: {
          ...VALID_BUNDLE.negotiation,
          capabilities: ['tools', 'tools'],
        },
      })
    ).toThrowError(/capabilities.*unique/i);

    expect(() => parseMcpEvidenceBundle({ ...VALID_BUNDLE, correlationIds: [] })).toThrowError(
      /correlationIds.*non-empty/i
    );
  });

  it('requires explicit blocker records when the scenario is blocked', () => {
    const blockedBundle = {
      ...VALID_BUNDLE,
      blockers: [
        {
          code: 'linear-oauth-consent-unavailable',
          description: 'The disposable test workspace cannot grant the requested scope.',
          owner: 'MCP verification',
        },
      ],
    };

    expect(parseMcpEvidenceBundle(blockedBundle).blockers).toEqual(blockedBundle.blockers);
    expect(() =>
      parseMcpEvidenceBundle({
        ...VALID_BUNDLE,
        blockers: [{ code: 'missing-description', owner: 'MCP verification' }],
      })
    ).toThrowError(/blockers\[0\]\.description.*required/i);
  });

  it.each([
    ['bearer token', 'Authorization: Bearer mcp_live_0123456789abcdef'],
    ['authorization code', 'authorization_code=SplxlOBeZQQYbYS6WxSbIA'],
    ['PKCE verifier', 'code_verifier: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ],
    ['private key', `${'-----BEGIN'} PRIVATE KEY-----\nMIIEvQIBADANBg`],
    ['credential URL', 'https://operator:correct-horse@example.com/callback'],
    ['OAuth callback URL', 'https://example.com/callback?code=SplxlOBeZQQYbYS6WxSbIA'],
  ])('detects a %s without returning the secret value', (_label, text) => {
    const findings = scanEvidenceTextForSecrets(text);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(
      expect.objectContaining({ index: expect.any(Number), kind: expect.any(String) })
    );
    expect(findings[0]).not.toHaveProperty('match');
    expect(JSON.stringify(findings)).not.toContain('SplxlOBeZQQYbYS6WxSbIA');
    expect(JSON.stringify(findings)).not.toContain('correct-horse');
  });

  it('does not mistake exact-head hashes or ordinary verifier prose for secrets', () => {
    expect(
      scanEvidenceTextForSecrets(
        'Commit 0123456789abcdef0123456789abcdef01234567; the verifier rejected code 1.'
      )
    ).toEqual([]);
  });

  it('secret-scans textual evidence recursively and reports only its path and secret class', () => {
    const secretBundle = {
      ...VALID_BUNDLE,
      cleanup: {
        ...VALID_BUNDLE.cleanup,
        details: 'Captured Authorization: Bearer mcp_live_0123456789abcdef',
      },
    };

    expect(() => parseMcpEvidenceBundle(secretBundle)).toThrowError(
      /cleanup\.details.*bearer-token/i
    );
    try {
      parseMcpEvidenceBundle(secretBundle);
    } catch (error: unknown) {
      expect(JSON.stringify(error)).not.toContain('mcp_live_0123456789abcdef');
    }
  });
});
