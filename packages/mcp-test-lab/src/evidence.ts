import {
  type McpArtifactIntegrityDependencies,
  type McpArtifactIntegrityResult,
  verifyMcpEvidenceArtifactIntegrity,
} from './evidence-artifact-integrity.js';

export type {
  McpArtifactIntegrityCode,
  McpArtifactIntegrityDependencies,
  McpVerifiedArtifact,
} from './evidence-artifact-integrity.js';
export { McpArtifactIntegrityError } from './evidence-artifact-integrity.js';
export type {
  McpArtifactKind,
  McpArtifactReference,
  McpCommandPhase,
  McpEvidenceBlocker,
  McpEvidenceCommand,
  McpEvidenceSchema,
  McpEvidenceValidationCode,
  McpEvidenceValidationIssue,
  McpProtocolEra,
  McpTestCounts,
} from './evidence-schema.js';
export { MCP_EVIDENCE_SCHEMA_VERSION, McpEvidenceValidationError } from './evidence-schema.js';

export type McpEvidenceBundle = McpArtifactIntegrityResult;

export async function verifyMcpEvidenceBundle(
  input: unknown,
  dependencies: McpArtifactIntegrityDependencies
): Promise<McpEvidenceBundle> {
  const result = await verifyMcpEvidenceArtifactIntegrity(input, dependencies);
  return deepFreeze(result);
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen);
  }
  return value;
}
