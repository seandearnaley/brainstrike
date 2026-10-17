import { Schema } from 'effect';
import { childExecutionConfigurationSchema } from './child-execution-configuration.js';
import {
  type AssistantPersonaDefinition,
  type AssistantPersonaMode,
  type AssistantPersonaSource,
  assertPersonaToolScope,
} from './personas.js';
import { findProviderDefinition } from './provider-registry.js';
import { SUBAGENT_SETTINGS_LIMITS } from './subagent-settings.js';

/** Fixed, safe remediation at the authenticated child-resume boundary. */
const ADMITTED_CHILD_FAILURES = {
  'ancestry-incomplete': 'The admitted child configuration has incomplete authorized ancestry.',
  'catalog-unknown':
    'This older child configuration has no captured tool catalog. Start a new delegation to establish its permitted tools.',
  'host-capability-unavailable':
    'Delegated persona restoration requires host-owned ancestry verification.',
  'identity-mismatch':
    'The admitted child configuration belongs to another persona and cannot be resumed.',
  'invalid-configuration':
    'The admitted child configuration is missing or unsupported. Start a new delegation to capture a valid configuration.',
  'model-or-tools-unavailable':
    'The admitted child cannot resume with the current model or host permissions. Restore its model and permitted tools, or start a new delegation.',
  'permission-scope-invalid':
    'The admitted child configuration contains tools its declared mode does not permit. Start a new delegation with a valid tool scope.',
  'runtime-unavailable':
    'The admitted child requires its authenticated root runtime before credentials can be restored.',
} as const;
export type AdmittedChildConfigurationFailure = keyof typeof ADMITTED_CHILD_FAILURES;
/** No stored profile text, provider output or credential appears in the public message. */
export class AdmittedChildConfigurationError extends Error {
  readonly code = 'admitted_child_configuration_unavailable';
  override readonly name = 'AdmittedChildConfigurationError';
  readonly reason: AdmittedChildConfigurationFailure;
  constructor(reason: AdmittedChildConfigurationFailure, options?: ErrorOptions) {
    super(ADMITTED_CHILD_FAILURES[reason], options);
    this.reason = reason;
  }
}
const nonempty = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length > 0 ? undefined : { issue: 'Invalid input', path: [] }
  )
);
const modes = { 'read-only': 'read-only', worker: 'worker' } as const satisfies {
  [Mode in AssistantPersonaMode]: Mode;
};
const sources = { 'built-in': 'built-in', user: 'user' } as const satisfies {
  [Source in AssistantPersonaSource]: Source;
};
// Required keys include optional contract fields: a new field must define its
// durable parser here instead of silently disappearing on resume.
const personaShape = {
  allowedToolIds: Schema.mutable(Schema.Array(nonempty)).check(Schema.isMinLength(1)),
  description: nonempty,
  id: nonempty,
  instructions: nonempty,
  label: nonempty,
  maxSteps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  mode: Schema.optional(Schema.Enum(modes)),
  model: Schema.optional(
    Schema.Struct({
      modelId: nonempty,
      provider: nonempty.check(
        Schema.makeFilter((provider) =>
          findProviderDefinition(provider) === undefined
            ? { issue: 'Invalid input', path: [] }
            : undefined
        )
      ),
    })
  ),
  source: Schema.optional(Schema.Enum(sources)),
} satisfies {
  [Key in keyof Required<AssistantPersonaDefinition>]: Schema.ConstraintDecoder<
    AssistantPersonaDefinition[Key]
  >;
};
export const admittedPersonaConfigurationSchema = Schema.Struct({
  execution: Schema.optional(childExecutionConfigurationSchema),
  maxSteps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
    Schema.isLessThanOrEqualTo(SUBAGENT_SETTINGS_LIMITS.maxChildSteps.max)
  ),
  persona: Schema.Struct(personaShape),
});
/** Parse the immutable host-authorized profile for decisions and explicit child wakes. */
export function readAdmittedPersonaConfiguration(
  configuration: unknown,
  expectedPersonaId?: string
): AssistantPersonaDefinition {
  const parsed = Schema.decodeUnknownResult(admittedPersonaConfigurationSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(configuration);
  if (!(parsed._tag === 'Success')) {
    throw new AdmittedChildConfigurationError('invalid-configuration');
  }
  if (expectedPersonaId !== undefined && parsed.success.persona.id !== expectedPersonaId) {
    throw new AdmittedChildConfigurationError('identity-mismatch');
  }
  if (parsed.success.persona.allowedToolIds.includes('*')) {
    throw new AdmittedChildConfigurationError('catalog-unknown');
  }
  const { mode, model, source, ...definition } = parsed.success.persona;
  const persona: AssistantPersonaDefinition = {
    ...definition,
    maxSteps: parsed.success.maxSteps,
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(source ? { source } : {}),
  };
  try {
    assertPersonaToolScope(persona);
  } catch (cause) {
    throw new AdmittedChildConfigurationError('permission-scope-invalid', { cause });
  }
  return persona;
}
