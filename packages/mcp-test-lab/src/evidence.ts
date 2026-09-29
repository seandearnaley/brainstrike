import {
  type McpArtifactIntegrityDependencies,
  type McpArtifactIntegrityResult,
  verifyParsedMcpEvidenceArtifactIntegrity,
} from './evidence-artifact-integrity.js';
import { parseMcpEvidenceSchema } from './evidence-schema.js';
import { createEvidenceSanitizationSession } from './evidence-structured-secrets.js';

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
  McpDesktopEvidence,
  McpDesktopManualScenarioEvidence,
  McpDesktopManualScenarioId,
  McpEvidenceBlocker,
  McpEvidenceCommand,
  McpEvidenceFixtureVersion,
  McpEvidenceSchema,
  McpEvidenceValidationCode,
  McpEvidenceValidationIssue,
  McpProtocolEra,
  McpTestCounts,
} from './evidence-schema.js';
export {
  MCP_DESKTOP_MANUAL_SCENARIO_IDS,
  MCP_EVIDENCE_SCHEMA_VERSION,
  McpEvidenceValidationError,
} from './evidence-schema.js';
export type {
  McpEvidenceSecretCode,
  McpEvidenceSecretIssue,
} from './evidence-structured-secrets.js';
export { McpEvidenceSecretError } from './evidence-structured-secrets.js';

export type McpEvidenceBundle = McpArtifactIntegrityResult;

export async function verifyMcpEvidenceBundle(
  input: unknown,
  dependencies: McpArtifactIntegrityDependencies
): Promise<McpEvidenceBundle> {
  const schema = parseMcpEvidenceSchema(input);
  const sanitizer = createEvidenceSanitizationSession();
  sanitizer.assertMetadataSanitized(schema, '$');
  const result = await verifyParsedMcpEvidenceArtifactIntegrity(
    schema,
    dependencies,
    (text, index) => {
      sanitizer.assertTextSanitized(text, `$.artifacts[${index}].content`);
    }
  );
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
