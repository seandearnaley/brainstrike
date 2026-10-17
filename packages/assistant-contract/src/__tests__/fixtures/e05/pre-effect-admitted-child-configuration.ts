// Preconversion Zod oracle, test-only.
import { z } from 'zod';
import {
  type AssistantPersonaDefinition,
  type AssistantPersonaMode,
  type AssistantPersonaSource,
  assertPersonaToolScope,
} from '../../../personas.js';
import { findProviderDefinition } from '../../../provider-registry.js';
import { SUBAGENT_SETTINGS_LIMITS } from '../../../subagent-settings.js';
import { childExecutionConfigurationSchema } from './pre-effect-child-execution-configuration.js';

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

const nonempty = z.string().refine((value) => value.trim().length > 0);
const modes = { 'read-only': 'read-only', worker: 'worker' } as const satisfies {
  [Mode in AssistantPersonaMode]: Mode;
};
const sources = { 'built-in': 'built-in', user: 'user' } as const satisfies {
  [Source in AssistantPersonaSource]: Source;
};
// Required keys include optional contract fields: a new field must define its
// durable parser here instead of silently disappearing on resume.
const personaShape = {
  allowedToolIds: z.array(nonempty).min(1),
  description: nonempty,
  id: nonempty,
  instructions: nonempty,
  label: nonempty,
  maxSteps: z.number().int().min(1),
  mode: z.enum(modes).optional(),
  model: z
    .strictObject({
      modelId: nonempty,
      provider: nonempty.refine((provider) => findProviderDefinition(provider) !== undefined),
    })
    .optional(),
  source: z.enum(sources).optional(),
} satisfies {
  [Key in keyof Required<AssistantPersonaDefinition>]: z.ZodType<AssistantPersonaDefinition[Key]>;
};
export const admittedPersonaConfigurationSchema = z.strictObject({
  execution: childExecutionConfigurationSchema.optional(),
  maxSteps: z.number().int().min(1).max(SUBAGENT_SETTINGS_LIMITS.maxChildSteps.max),
  persona: z.strictObject(personaShape),
});

/** Parse the immutable host-authorized profile for decisions and explicit child wakes. */
export function readAdmittedPersonaConfiguration(
  configuration: unknown,
  expectedPersonaId?: string
): AssistantPersonaDefinition {
  const parsed = admittedPersonaConfigurationSchema.safeParse(configuration);
  if (!parsed.success) {
    throw new AdmittedChildConfigurationError('invalid-configuration');
  }
  if (expectedPersonaId !== undefined && parsed.data.persona.id !== expectedPersonaId) {
    throw new AdmittedChildConfigurationError('identity-mismatch');
  }
  if (parsed.data.persona.allowedToolIds.includes('*')) {
    throw new AdmittedChildConfigurationError('catalog-unknown');
  }
  const { mode, model, source, ...definition } = parsed.data.persona;
  const persona: AssistantPersonaDefinition = {
    ...definition,
    maxSteps: parsed.data.maxSteps,
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
