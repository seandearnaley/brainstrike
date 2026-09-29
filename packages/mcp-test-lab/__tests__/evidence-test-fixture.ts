import type { McpEvidenceSchema } from '../src/evidence-schema';
import { getMcpLabScenario } from '../src/scenario';

type MutableEvidence<T> = T extends readonly (infer Entry)[]
  ? MutableEvidence<Entry>[]
  : T extends string | number | boolean
    ? T extends string
      ? string
      : T extends number
        ? number
        : boolean
    : T extends object
      ? { -readonly [Key in keyof T]: MutableEvidence<T[Key]> }
      : T;
const SHA256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RED_TESTS = { failed: 1, passed: 0, skipped: 0, total: 1 } as const;
const GREEN_TESTS = { failed: 0, passed: 1, skipped: 0, total: 1 } as const;
const MODERN_SCENARIO = getMcpLabScenario('modern-reference');

export const VALID_EVIDENCE_SCHEMA = {
  artifacts: [{ kind: 'log', reference: 'artifacts/a.log', sanitized: true, sha256: SHA256 }],
  blockers: [{ code: 'blocked', description: 'Waiting', owner: 'BST-1485' }],
  cleanup: { command: 'cleanup', details: 'clean', exitStatus: 0, verified: true },
  commands: [
    { command: 'test', exitStatus: 1, phase: 'red', proofId: 'proof', tests: RED_TESTS },
    { command: 'test', exitStatus: 0, phase: 'green', proofId: 'proof', tests: GREEN_TESTS },
    { command: 'test', exitStatus: 0, phase: 'verification', proofId: 'proof', tests: GREEN_TESTS },
  ],
  correlationIds: ['1'],
  desktop: { reason: 'protocol-lab-only', required: false },
  git: { commitSha: '0123456789abcdef0123456789abcdef01234567', workspaceState: 'clean' },
  negotiation: {
    capabilities: ['completions', 'prompts', 'resources', 'tools'],
    era: 'modern',
    revision: '2026-07-28',
  },
  scenarioId: 'modern-reference',
  schemaVersion: '1.1.0',
  ticket: 'BST-1484',
  versions: {
    conformance: { package: '@modelcontextprotocol/conformance', version: '0.2.0-alpha.10' },
    fixture: { id: MODERN_SCENARIO.fixture, ...MODERN_SCENARIO.fixtureSource },
    sdk: { package: '@modelcontextprotocol/client', version: MODERN_SCENARIO.reference.sdkVersion },
    spec: '2026-07-28',
  },
} as const satisfies McpEvidenceSchema;

export function evidenceFixture(): MutableEvidence<McpEvidenceSchema> {
  return structuredClone(VALID_EVIDENCE_SCHEMA) as unknown as MutableEvidence<McpEvidenceSchema>;
}
