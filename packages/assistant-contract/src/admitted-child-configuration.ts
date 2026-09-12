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
