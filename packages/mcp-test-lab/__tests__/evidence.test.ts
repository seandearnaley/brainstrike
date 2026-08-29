import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MCP_EVIDENCE_SCHEMA_VERSION,
  type McpEvidenceBundle,
  McpEvidenceValidationError,
  parseMcpEvidenceBundle,
  scanEvidenceTextForSecrets,
} from '../src/evidence';

const VALID_ARTIFACT_CONTENT = { entries: [{ message: 'sanitized lifecycle event' }] } as const;
const VALID_ARTIFACT_BYTES = new TextEncoder().encode(JSON.stringify(VALID_ARTIFACT_CONTENT));
const VALID_ARTIFACT_SHA256 = createHash('sha256').update(VALID_ARTIFACT_BYTES).digest('hex');

const VALID_BUNDLE = {
  artifacts: [
    {
      kind: 'log',
      reference: 'artifacts/main-process.ndjson',
      sanitized: true,
      sha256: VALID_ARTIFACT_SHA256,
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
      proofId: 'evidence-secret-scan',
      tests: { failed: 1, passed: 0, skipped: 0, total: 1 },
    },
    {
      command: 'pnpm vitest run evidence.test.ts',
      exitStatus: 0,
      phase: 'green',
      proofId: 'evidence-secret-scan',
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

const VALIDATION_DEPENDENCIES = {
  readArtifactContent(reference: string) {
    if (reference !== 'artifacts/main-process.ndjson') {
      throw new Error('artifact fixture is unavailable');
    }
    return { bytes: VALID_ARTIFACT_BYTES };
  },
} as const;

function parseEvidence(input: unknown): McpEvidenceBundle {
  return parseMcpEvidenceBundle(input, VALIDATION_DEPENDENCIES);
}

describe('parseMcpEvidenceBundle', () => {
  it('accepts a complete exact-head MCP scenario evidence bundle', () => {
    expect(MCP_EVIDENCE_SCHEMA_VERSION).toBe('1.0.0');
    expect(parseEvidence(VALID_BUNDLE)).toEqual(VALID_BUNDLE);
  });

  it('rejects a syntactically valid digest that does not match the artifact content', () => {
    const mismatched = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    };

    expect(() => parseEvidence(mismatched)).toThrowError(/artifacts\[0\]\.sha256.*content/i);
  });

  it('digests exact binary artifact bytes independently of the parsed scan view', () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          kind: 'screenshot',
          reference: 'artifacts/oauth-dialog.png',
          sanitized: true,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(
      parseMcpEvidenceBundle(bundle, {
        extractScreenshotText: (receivedBytes, reference) => {
          expect(receivedBytes).toEqual(bytes);
          expect(reference).toBe('artifacts/oauth-dialog.png');
          return 'sanitized OAuth dialog screenshot';
        },
        readArtifactContent: () => ({
          bytes,
        }),
      })
    ).toEqual(bundle);
  });

  it('rejects screenshots without exact-byte text extraction', () => {
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          kind: 'screenshot',
          reference: 'artifacts/oauth-dialog.png',
          sanitized: true,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/screenshot evidence requires exact-byte text extraction/i);
  });

  it('rejects image references mislabeled as text and non-text bytes in text artifacts', () => {
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    const mislabeled = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          kind: 'report',
          reference: 'artifacts/oauth-dialog.png',
          sanitized: true,
          sha256: createHash('sha256').update(imageBytes).digest('hex'),
        },
      ],
    };
    const binaryText = {
      ...mislabeled,
      artifacts: [{ ...mislabeled.artifacts[0], reference: 'artifacts/oauth-dialog.md' }],
    };

    expect(() => parseMcpEvidenceBundle(mislabeled, VALIDATION_DEPENDENCIES)).toThrowError(
      /extension.*incompatible.*report/i
    );
    expect(() =>
      parseMcpEvidenceBundle(binaryText, {
        readArtifactContent: () => ({ bytes: imageBytes }),
      })
    ).toThrowError(/report evidence must contain valid UTF-8 text/i);
  });

  it('secret-scans screenshot text extracted from the exact hashed bytes', () => {
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          kind: 'screenshot',
          reference: 'artifacts/oauth-dialog.png',
          sanitized: true,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, {
        extractScreenshotText: () => 'Bearer mcp_live_0123456789abcdef',
        readArtifactContent: () => ({ bytes }),
      })
    ).toThrowError(/bearer-token/i);
  });

  it('decodes HTML character references before secret-scanning report artifacts', () => {
    for (const encodedAssignment of [
      'client_secret&#61;opaque-value',
      'client_secret&#x3d;opaque-value',
      'client_secret&equals;opaque-value',
    ]) {
      const bytes = new TextEncoder().encode(`<pre>${encodedAssignment}</pre>`);
      const bundle = {
        ...VALID_BUNDLE,
        artifacts: [
          {
            kind: 'report',
            reference: 'artifacts/oauth-report.html',
            sanitized: true,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      };

      expect(() =>
        parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
      ).toThrowError(/artifacts\[0\]\.content.*credential-assignment/i);
    }
  });

  it('parses JSON-looking screenshot text before accepting it', () => {
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          kind: 'screenshot',
          reference: 'artifacts/oauth-dialog.png',
          sanitized: true,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, {
        extractScreenshotText: () => '{"access\\u005ftoken":"q"}',
        readArtifactContent: () => ({ bytes }),
      })
    ).toThrowError(/credential-assignment/i);
  });

  it('detects secrets decoded from JSON escapes in the exact artifact bytes', () => {
    const bytes = new TextEncoder().encode('{"message":"Be\\u0061rer mcp_live_0123456789abcdef"}');
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/bearer-token/i);
  });

  it('detects credentials whose JSON property name is Unicode-escaped', () => {
    const bytes = new TextEncoder().encode('{"access\\u005ftoken":"opaque-0123456789abcdef"}');
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it('detects punctuation-only credentials in parsed JSON', () => {
    const bytes = new TextEncoder().encode('{"client_secret":"#"}');
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it.each([
    'OPENAI_API_KEY=sk-test',
    'AWS_SECRET_ACCESS_KEY=x',
    'client_secret="#"',
    "client_secret=';'",
  ])('detects namespaced or punctuation-only assignment %s', (text) => {
    expect(scanEvidenceTextForSecrets(text)).toEqual([
      expect.objectContaining({ kind: 'credential-assignment' }),
    ]);
  });

  it('detects namespaced credential keys in parsed JSON', () => {
    const bytes = new TextEncoder().encode('{"openai_api_key":"x"}');
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it('does not classify ordinary namespaced metadata as credentials', () => {
    expect(
      scanEvidenceTextForSecrets(
        'status_code=200 input_token=42 not_authorization=false https://example.test/?status-code=200'
      )
    ).toEqual([]);

    const bytes = new TextEncoder().encode(
      '{"status_code":"200","input_token":"42","not_authorization":"false"}'
    );
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };
    expect(
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toMatchObject({ ticket: 'BST-1475' });
  });

  it('detects trusted GH token keys across raw, parsed, and URL evidence', () => {
    expect(scanEvidenceTextForSecrets('GH_TOKEN=opaque-value')).toEqual([
      expect.objectContaining({ kind: 'credential-assignment' }),
    ]);
    expect(scanEvidenceTextForSecrets('https://example.test/callback?github-token=x')).toEqual([
      expect.objectContaining({ kind: 'credential-bearing-url' }),
    ]);

    const bytes = new TextEncoder().encode('{"github_token":"x"}');
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };
    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it.each([
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_ACCESS_KEY_ID',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
  ])('detects the repository-supported %s credential key', (credentialKey) => {
    expect(scanEvidenceTextForSecrets(`${credentialKey}=opaque-value`)).toEqual([
      expect.objectContaining({ kind: 'credential-assignment' }),
    ]);
    expect(
      scanEvidenceTextForSecrets(`https://example.test/callback?${credentialKey}=opaque-value`)
    ).toEqual([expect.objectContaining({ kind: 'credential-bearing-url' })]);
  });

  it('rejects nested values under decoded credential keys', () => {
    const bytes = new TextEncoder().encode('{"access\\u005ftoken":["abc"]}');
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };
    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it('detects credentials inside serialized JSON string fields', () => {
    const bytes = new TextEncoder().encode(
      '{"body":"{\\"access\\\\u005ftoken\\":\\"opaque-0123456789abcdef\\"}"}'
    );
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it('detects credentials inside serialized NDJSON string fields', () => {
    const nestedNdjson = '{"ok":true}\n{"access\\u005ftoken":"x"}';
    const bytes = new TextEncoder().encode(JSON.stringify({ body: nestedNdjson }));
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it('detects serialized credentials with Unicode-escaped container delimiters', () => {
    const serialized = '\\u007b"access\\u005ftoken":"x"\\u007d';
    const bytes = new TextEncoder().encode(JSON.stringify({ body: serialized }));
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
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

    expect(() => parseEvidence(missingTicket)).toThrowError(/ticket.*required/i);
    expect(() => parseEvidence(unknownRoot)).toThrowError(/generatedAt.*unknown/i);
    expect(() => parseEvidence(unknownNested)).toThrowError(/git\.branch.*unknown/i);
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
      expect(() => parseEvidence(malformed)).toThrow(McpEvidenceValidationError);
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

    expect(() => parseEvidence(greenBeforeRed)).toThrowError(/RED.*first/i);
    expect(() => parseEvidence(passingRed)).toThrowError(/RED.*non-zero/i);
    expect(() => parseEvidence(failingGreen)).toThrowError(/GREEN.*zero/i);
    expect(() => parseEvidence(verificationBeforeGreen)).toThrowError(/verification.*GREEN/i);
  });

  it.each([
    { failed: 0, passed: 0, skipped: 0, total: 0 },
    { failed: 0, passed: 1, skipped: 0, total: 1 },
  ])('requires RED proof to report an actual failed test: %o', (tests) => {
    const invalidRed = {
      ...VALID_BUNDLE,
      commands: [{ ...VALID_BUNDLE.commands[0], tests }, VALID_BUNDLE.commands[1]],
    };

    expect(() => parseEvidence(invalidRed)).toThrowError(/RED.*failed test/i);
  });

  it('requires RED proof failure counts to be internally consistent', () => {
    const invalidRed = {
      ...VALID_BUNDLE,
      commands: [
        {
          ...VALID_BUNDLE.commands[0],
          tests: { failed: 1, passed: 0, skipped: 0, total: 2 },
        },
        VALID_BUNDLE.commands[1],
      ],
    };

    expect(() => parseEvidence(invalidRed)).toThrowError(/tests\.total.*equal/i);
  });

  it('binds each GREEN proof to the behavior exercised by its RED proof', () => {
    const unrelatedGreen = {
      ...VALID_BUNDLE,
      commands: [
        { ...VALID_BUNDLE.commands[0], command: 'pnpm vitest run -t failing-behavior' },
        {
          ...VALID_BUNDLE.commands[1],
          command: 'pnpm vitest run -t unrelated-behavior',
          proofId: 'unrelated-behavior',
        },
      ],
    };

    expect(() => parseEvidence(unrelatedGreen)).toThrowError(/GREEN.*matching RED|proof/i);

    const sameProofIdDifferentCommand = {
      ...VALID_BUNDLE,
      commands: [
        { ...VALID_BUNDLE.commands[0], command: 'pnpm vitest run -t focused-behavior' },
        { ...VALID_BUNDLE.commands[1], command: 'true' },
      ],
    };
    expect(() => parseEvidence(sameProofIdDifferentCommand)).toThrowError(
      /GREEN.*same command.*RED/i
    );
  });

  it('requires observed protocol identity, unique capabilities, and correlation IDs', () => {
    expect(() =>
      parseEvidence({
        ...VALID_BUNDLE,
        negotiation: {
          ...VALID_BUNDLE.negotiation,
          capabilities: ['tools', 'tools'],
        },
      })
    ).toThrowError(/capabilities.*unique/i);

    expect(() => parseEvidence({ ...VALID_BUNDLE, correlationIds: [] })).toThrowError(
      /correlationIds.*non-empty/i
    );
    expect(() =>
      parseEvidence({
        ...VALID_BUNDLE,
        negotiation: { ...VALID_BUNDLE.negotiation, revision: '2025-11-25' },
      })
    ).toThrowError(/era.*revision|revision.*era/i);
  });

  it('binds the recorded spec version to the negotiated revision', () => {
    expect(() =>
      parseEvidence({
        ...VALID_BUNDLE,
        versions: { ...VALID_BUNDLE.versions, spec: '2025-11-25' },
      })
    ).toThrowError(/versions\.spec.*negotiation\.revision/i);
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

    expect(parseEvidence(blockedBundle).blockers).toEqual(blockedBundle.blockers);
    expect(() =>
      parseEvidence({
        ...VALID_BUNDLE,
        blockers: [{ code: 'missing-description', owner: 'MCP verification' }],
      })
    ).toThrowError(/blockers\[0\]\.description.*required/i);
  });

  it.each([
    ['bearer token', 'Authorization: Bearer abc'],
    ['Basic authorization', 'Authorization: Basic dTpw'],
    ['authorization code', 'authorization_code=SplxlOBeZQQYbYS6WxSbIA'],
    ['PKCE verifier', 'code_verifier: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
    ['JWT', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['private key', `${'-----BEGIN'} PRIVATE KEY-----\nMIIEvQIBADANBg`],
    ['encrypted private key', `${'-----BEGIN'} ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0B`],
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

  it('rejects duplicate artifact references before reading content', () => {
    let reads = 0;
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [VALID_BUNDLE.artifacts[0], { ...VALID_BUNDLE.artifacts[0] }],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, {
        readArtifactContent: () => {
          reads += 1;
          return { bytes: VALID_ARTIFACT_BYTES };
        },
      })
    ).toThrowError(/artifact references.*unique/i);
    expect(reads).toBe(0);
  });

  it('returns a deeply frozen validated snapshot', () => {
    const bundle = parseEvidence(VALID_BUNDLE);

    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.artifacts)).toBe(true);
    expect(Object.isFrozen(bundle.artifacts[0])).toBe(true);
    expect(Object.isFrozen(bundle.commands)).toBe(true);
    expect(Object.isFrozen(bundle.commands[0]?.tests)).toBe(true);
    expect(Object.isFrozen(bundle.git)).toBe(true);
    expect(Object.isFrozen(bundle.negotiation.capabilities)).toBe(true);
    expect(Reflect.set(bundle, 'ticket', 'BST-9999')).toBe(false);
    expect(Reflect.set(bundle.artifacts[0] ?? {}, 'reference', 'artifacts/unchecked.json')).toBe(
      false
    );
    expect(bundle).toEqual(VALID_BUNDLE);
  });

  it.each([
    'access_token',
    'api_key',
    'authorization',
    'client_secret',
    'code',
    'code_verifier',
    'password',
    'refresh_token',
    'token',
  ])('detects standalone %s assignments without returning their values', (credentialKey) => {
    const credential = 'q';
    const equalsFindings = scanEvidenceTextForSecrets(`${credentialKey}=${credential}`);
    const jsonFindings = scanEvidenceTextForSecrets(`"${credentialKey}": "${credential}"`);

    expect(equalsFindings.length).toBeGreaterThan(0);
    expect(jsonFindings.length).toBeGreaterThan(0);
    expect(JSON.stringify([...equalsFindings, ...jsonFindings])).not.toContain(credential);
  });

  it.each([
    'access_token',
    'api_key',
    'authorization',
    'client_secret',
    'code',
    'code_verifier',
    'password',
    'refresh_token',
    'token',
  ])('detects %s values in URL fragments without returning their values', (credentialKey) => {
    const credential = `opaque-${'0123456789abcdef'}`;
    const findings = scanEvidenceTextForSecrets(
      `https://example.com/callback#${credentialKey}=${credential}`
    );

    expect(findings).toEqual([expect.objectContaining({ kind: 'credential-bearing-url' })]);
    expect(JSON.stringify(findings)).not.toContain(credential);
  });

  it('normalizes hyphenated credential keys inside URLs', () => {
    expect(scanEvidenceTextForSecrets('https://example.test/callback?api-key=q')).toEqual([
      expect.objectContaining({ kind: 'credential-bearing-url' }),
    ]);
  });

  it('preserves terminal punctuation that is the URL credential value', () => {
    expect(scanEvidenceTextForSecrets('https://example.test/callback?client_secret=)')).toEqual([
      expect.objectContaining({ kind: 'credential-bearing-url' }),
    ]);
  });

  it('does not mistake exact-head hashes or ordinary verifier prose for secrets', () => {
    expect(
      scanEvidenceTextForSecrets(
        'Commit 0123456789abcdef0123456789abcdef01234567; the verifier rejected code 1.'
      )
    ).toEqual([]);
    expect(
      scanEvidenceTextForSecrets(
        'exit code: INTERNAL_ERROR_XYZ; error code = ECONNREFUSED; authorization: not-required-here; token: redacted'
      )
    ).toEqual([]);
    expect(scanEvidenceTextForSecrets('token=SECRETSECRET')).not.toEqual([]);
    expect(scanEvidenceTextForSecrets('authorization=BEARERTOKEN')).not.toEqual([]);
    expect(scanEvidenceTextForSecrets('code=ABCDEFGH')).not.toEqual([]);
  });

  it('accepts canonical safe sentinels for every recognized credential key', () => {
    expect(scanEvidenceTextForSecrets('client_secret=redacted')).toEqual([]);
    expect(
      scanEvidenceTextForSecrets('https://example.test/callback?client_secret=redacted')
    ).toEqual([]);

    const bytes = new TextEncoder().encode('{"client_secret":"redacted"}');
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toMatchObject({ ticket: 'BST-1475' });
  });

  it('preserves punctuation inside quoted credential values', () => {
    expect(scanEvidenceTextForSecrets('client_secret="redacted)"')).toEqual([
      expect.objectContaining({ kind: 'credential-assignment' }),
    ]);
    expect(scanEvidenceTextForSecrets('client_secret=redacted)')).toEqual([]);
  });

  it('accepts canonical redaction sentinels in Authorization schemes only', () => {
    expect(scanEvidenceTextForSecrets('Authorization: Bearer redacted')).toEqual([]);
    expect(scanEvidenceTextForSecrets('Authorization: Basic none')).toEqual([]);
    expect(scanEvidenceTextForSecrets('Authorization: Bearer opaque-secret')).not.toEqual([]);
    expect(scanEvidenceTextForSecrets('Authorization: Basic dTpw')).not.toEqual([]);
  });

  it('secret-scans textual evidence recursively and reports only its path and secret class', () => {
    const secretBundle = {
      ...VALID_BUNDLE,
      cleanup: {
        ...VALID_BUNDLE.cleanup,
        details: 'Captured Authorization: Bearer mcp_live_0123456789abcdef',
      },
    };

    expect(() => parseEvidence(secretBundle)).toThrowError(/cleanup\.details.*bearer-token/i);
    try {
      parseEvidence(secretBundle);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(McpEvidenceValidationError);
      expect((error as McpEvidenceValidationError).issue.index).toBe(
        secretBundle.cleanup.details.indexOf('Bearer')
      );
      expect(String(error)).not.toContain('mcp_live_0123456789abcdef');
    }
  });

  it('recursively secret-scans referenced artifact contents despite sanitized metadata', () => {
    const credential = `mcp_${'live_0123456789abcdef'}`;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ entries: [{ message: `Authorization: Bearer ${credential}` }] })
    );
    const readArtifactContent = (_reference: string) => ({
      bytes,
    });
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() => parseMcpEvidenceBundle(bundle, { readArtifactContent })).toThrowError(
      /artifacts\[0\]\.content.*bearer-token/i
    );
    try {
      parseMcpEvidenceBundle(bundle, { readArtifactContent });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(credential);
    }
  });

  it('detects escaped JSON credentials embedded in prefixed log lines', () => {
    const bytes = new TextEncoder().encode(
      'INFO meta={"safe":true} body={\\"access_token\\":\\"opaque-secret\\"}'
    );
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it('detects a balanced JSON credential container before trailing text', () => {
    const bytes = new TextEncoder().encode(
      '<script>{"access\\u005ftoken":"opaque-secret"}</script>'
    );
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it.each([
    String.raw`INFO body={\\"access_token\\":\\"opaque-secret\\"}`,
    String.raw`\u007b\u0022access_token\u0022:\u0022opaque-secret\u0022\u007d`,
  ])('detects multilayer or fully Unicode-escaped JSON credentials', (text) => {
    const bytes = new TextEncoder().encode(text);
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it('detects balanced prefixed JSON containers spanning multiple lines', () => {
    const bytes = new TextEncoder().encode(
      'INFO body={\n  "access\\u005ftoken":"opaque-secret"\n}'
    );
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/credential-assignment/i);
  });

  it('fails closed when a prefixed line exceeds the embedded JSON scan bound', () => {
    const bytes = new TextEncoder().encode(`INFO ${'{'.repeat(65)}`);
    const bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          ...VALID_BUNDLE.artifacts[0],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };

    expect(() =>
      parseMcpEvidenceBundle(bundle, { readArtifactContent: () => ({ bytes }) })
    ).toThrowError(/embedded JSON candidate count exceeds.*limit/i);
  });

  it('does not expose artifact reader errors that may contain credential material', () => {
    const credential = `mcp_${'live_0123456789abcdef'}`;
    const readArtifactContent = (_reference: string): never => {
      throw new Error(`read failed near Authorization: Bearer ${credential}`);
    };

    try {
      parseMcpEvidenceBundle(VALID_BUNDLE, { readArtifactContent });
      throw new Error('expected artifact validation to fail');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(McpEvidenceValidationError);
      expect(String(error)).toMatch(/artifacts\[0\]\.reference.*could not be read/i);
      expect(String(error)).not.toContain(credential);
      expect(JSON.stringify(error)).not.toContain(credential);
    }
  });
});
