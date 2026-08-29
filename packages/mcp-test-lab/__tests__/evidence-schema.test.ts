import { describe, expect, it, vi } from 'vitest';
import {
  MCP_EVIDENCE_SCHEMA_VERSION,
  McpEvidenceValidationError,
  parseMcpEvidenceSchema,
} from '../src/evidence-schema';
import { evidenceFixture, VALID_EVIDENCE_SCHEMA } from './evidence-test-fixture';

function expectInvalid(input: unknown, pattern: RegExp): void {
  expect(() => parseMcpEvidenceSchema(input)).toThrowError(pattern);
}
function commandAt(bundle: ReturnType<typeof evidenceFixture>, index: number) {
  const command = bundle.commands[index];
  if (command === undefined) {
    throw new Error(`Missing command fixture at index ${index}`);
  }
  return command;
}
function artifactAt(bundle: ReturnType<typeof evidenceFixture>, index = 0) {
  const artifact = bundle.artifacts[index];
  if (artifact === undefined) {
    throw new Error(`Missing artifact fixture at index ${index}`);
  }
  return artifact;
}
describe('parseMcpEvidenceSchema', () => {
  it('accepts a complete exact-head evidence schema', () => {
    expect(MCP_EVIDENCE_SCHEMA_VERSION).toBe('1.0.0');
    expect(parseMcpEvidenceSchema(VALID_EVIDENCE_SCHEMA)).toEqual(VALID_EVIDENCE_SCHEMA);
  });
  it('rejects missing and unknown fields at closed object boundaries', () => {
    const missing = evidenceFixture();
    Reflect.deleteProperty(missing, 'cleanup');
    expectInvalid(missing, /\$\.cleanup.*required field/i);
    const unknown = { ...evidenceFixture(), fallback: true };
    expectInvalid(unknown, /\$\.fallback.*unknown field/i);
    const nested = { ...evidenceFixture(), git: { ...VALID_EVIDENCE_SCHEMA.git, branch: 'main' } };
    expectInvalid(nested, /\$\.git\.branch.*unknown field/i);
  });
  it('enforces closed nested records and literal guarantees', () => {
    const cases: [RegExp, (bundle: ReturnType<typeof evidenceFixture>) => void][] = [
      [/versions\.extra/i, (bundle) => Object.assign(bundle.versions, { extra: true })],
      [/commands\[0\]\.extra/i, (bundle) => Object.assign(commandAt(bundle, 0), { extra: true })],
      [/tests\.extra/i, (bundle) => Object.assign(commandAt(bundle, 0).tests, { extra: true })],
      [/negotiation\.extra/i, (bundle) => Object.assign(bundle.negotiation, { extra: true })],
      [/artifacts\[0\]\.sanitized/i, (bundle) => (artifactAt(bundle).sanitized = false)],
      [/cleanup\.verified/i, (bundle) => (bundle.cleanup.verified = false)],
      [
        /blockers\[0\]\.owner/i,
        (bundle) => {
          bundle.blockers = [{ code: 'blocked', description: 'Waiting', owner: '' }];
        },
      ],
    ];
    for (const [pattern, mutate] of cases) {
      const bundle = evidenceFixture();
      mutate(bundle);
      expectInvalid(bundle, pattern);
    }
  });
  it('binds exact package versions, git identity, and ticket shape', () => {
    expectInvalid({ ...evidenceFixture(), ticket: 'GH-1484' }, /\$\.ticket.*exact BST ticket/i);
    expectInvalid(
      {
        ...evidenceFixture(),
        versions: {
          ...VALID_EVIDENCE_SCHEMA.versions,
          sdk: { package: '@modelcontextprotocol/sdk', version: '2.0.0' },
        },
      },
      /versions\.sdk\.package.*@modelcontextprotocol\/client/i
    );
    expectInvalid(
      { ...evidenceFixture(), git: { commitSha: 'abc', workspaceState: 'clean' } },
      /git\.commitSha.*40-character/i
    );
  });
  it('requires count consistency and a genuinely failing RED proof', () => {
    const inconsistent = evidenceFixture();
    commandAt(inconsistent, 0).tests.total = 2;
    expectInvalid(inconsistent, /commands\[0\]\.tests\.total.*passed \+ failed \+ skipped/i);
    const falseRed = evidenceFixture();
    commandAt(falseRed, 0).tests.failed = 0;
    commandAt(falseRed, 0).tests.passed = 1;
    expectInvalid(falseRed, /RED proof requires.*failed test/i);
  });
  it('binds GREEN and verification to a prior RED proof id and exact command', () => {
    const wrongId = evidenceFixture();
    commandAt(wrongId, 1).proofId = 'different-proof';
    expectInvalid(wrongId, /GREEN proof requires a matching prior RED/i);
    const wrongCommand = evidenceFixture();
    commandAt(wrongCommand, 1).command = 'pnpm vitest run another.test.ts';
    expectInvalid(wrongCommand, /GREEN proof must run the same command/i);
    const verificationFirst = evidenceFixture();
    verificationFirst.commands = [
      {
        ...commandAt(verificationFirst, 0),
        exitStatus: 0,
        phase: 'verification',
        tests: { failed: 0, passed: 1, skipped: 0, total: 1 },
      },
    ];
    expectInvalid(verificationFirst, /RED proof must be first/i);
    const wrongVerificationCommand = evidenceFixture();
    wrongVerificationCommand.commands.push({
      ...commandAt(wrongVerificationCommand, 1),
      command: 'pnpm vitest run unrelated.test.ts',
      phase: 'verification',
    });
    expectInvalid(wrongVerificationCommand, /verification must run the same command/i);
    const emptyVerification = evidenceFixture();
    commandAt(emptyVerification, 2).tests = { failed: 0, passed: 0, skipped: 0, total: 0 };
    expectInvalid(emptyVerification, /verification requires.*at least one passed test/i);
  });
  it('accepts strict SemVer and rejects leading-zero numeric prereleases', () => {
    const build = evidenceFixture();
    build.versions.sdk.version = '2.0.0-rc.1+build.7';
    expect(parseMcpEvidenceSchema(build).versions.sdk.version).toBe('2.0.0-rc.1+build.7');
    const leadingZero = evidenceFixture();
    leadingZero.versions.sdk.version = '2.0.0-01';
    expectInvalid(leadingZero, /versions\.sdk\.version.*semantic version/i);
  });
  it('binds protocol era, revision, and recorded spec version', () => {
    const wrongEra = evidenceFixture();
    wrongEra.negotiation.revision = '2025-11-25';
    expectInvalid(wrongEra, /era "modern" requires revision "2026-07-28"/i);
    const wrongSpec = evidenceFixture();
    wrongSpec.versions.spec = '2025-11-25';
    expectInvalid(wrongSpec, /versions\.spec.*must equal.*negotiation\.revision/i);
    const legacy = evidenceFixture();
    legacy.negotiation.era = 'legacy';
    legacy.negotiation.revision = '2025-11-25';
    legacy.versions.spec = '2025-11-25';
    expect(parseMcpEvidenceSchema(legacy).negotiation.era).toBe('legacy');
  });
  it('requires unique capabilities, correlation ids, and artifact references', () => {
    const capabilities = evidenceFixture();
    capabilities.negotiation.capabilities = ['tools', 'tools'];
    expectInvalid(capabilities, /negotiation\.capabilities.*unique/i);
    const correlations = evidenceFixture();
    const correlationId = correlations.correlationIds[0];
    if (correlationId === undefined) {
      throw new Error('Missing correlation id fixture');
    }
    correlations.correlationIds = [correlationId, correlationId];
    expectInvalid(correlations, /correlationIds.*unique/i);
    const artifacts = evidenceFixture();
    const artifact = artifactAt(artifacts);
    artifacts.artifacts = [artifact, { ...artifact }];
    expectInvalid(artifacts, /\$\.artifacts.*unique/i);
  });
  it('rejects unsafe artifact paths, mislabeled extensions, and malformed digests', () => {
    for (const reference of [
      'artifacts/../secret.txt',
      'https://example.test/report.json',
      'artifacts/forged\nline.log',
      `artifacts/${'a'.repeat(505)}.log`,
    ]) {
      const bundle = evidenceFixture();
      artifactAt(bundle).reference = reference;
      expectInvalid(bundle, /repository-relative path below artifacts/i);
    }
    const extension = evidenceFixture();
    artifactAt(extension).kind = 'screenshot';
    expectInvalid(extension, /extension is incompatible.*screenshot/i);
    const digest = evidenceFixture();
    artifactAt(digest).sha256 = 'ABC';
    expectInvalid(digest, /lowercase SHA-256 digest/i);
  });
  it('snapshots arrays by index without trusting overridden array methods', () => {
    const bundle = evidenceFixture();
    Object.defineProperty(bundle.commands, 'map', {
      value: () => {
        throw new Error('hostile map must not run');
      },
    });
    expect(parseMcpEvidenceSchema(bundle)).toMatchObject({ ticket: 'BST-1484' });
    const concealed = evidenceFixture();
    artifactAt(concealed).sanitized = false;
    const hostileMap = vi.fn(() => [VALID_EVIDENCE_SCHEMA.artifacts[0]]);
    Object.defineProperty(concealed.artifacts, 'map', { value: hostileMap });
    expectInvalid(concealed, /artifacts\[0\]\.sanitized/i);
    expect(hostileMap).not.toHaveBeenCalled();
  });
  it('snapshots array length once, bounds it, and sanitizes traps', () => {
    const bundle = evidenceFixture();
    let lengthReads = 0;
    bundle.commands = new Proxy(bundle.commands, {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          if (lengthReads > 1) {
            throw new Error('artifact-content-leak-marker');
          }
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(parseMcpEvidenceSchema(bundle).commands).toHaveLength(3);
    expect(lengthReads).toBe(1);
    const oversized = evidenceFixture();
    oversized.correlationIds = Array.from({ length: 1001 }, (_, index) => `correlation-${index}`);
    expectInvalid(oversized, /correlationIds.*at most 1000 items/i);
  });
  it('returns structured path and code diagnostics', () => {
    try {
      parseMcpEvidenceSchema({});
      throw new Error('Expected schema validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(McpEvidenceValidationError);
      expect((error as McpEvidenceValidationError).issue).toEqual({
        code: 'missing_field',
        message: 'required field is missing',
        path: '$.schemaVersion',
      });
    }
  });
});
