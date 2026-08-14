export function planSafeAddition({ candidate, manifest, baseCommit, nextMigrationVersion }) {
  if (!/^[0-9a-f]{40}$/u.test(baseCommit)) {
    throw new Error('exact base commit is required');
  }
  if (!Number.isSafeInteger(nextMigrationVersion) || nextMigrationVersion <= 0) {
    throw new Error('invalid next migration version');
  }
  if (
    candidate?.kind !== 'remote_addition_candidate' ||
    candidate.providerId !== 'openrouter' ||
    candidate.safety?.disposition !== 'safe_addition'
  ) {
    throw new Error('candidate is not a safe addition');
  }
  const source = manifest.sources.find(({ providerId }) => providerId === 'openrouter');
  if (source?.safeAddition?.eligible !== true) {
    throw new Error('safe addition source is not eligible');
  }
  if (!source.safeAddition.approvedModelIds?.includes(candidate.modelId)) {
    throw new Error('candidate is absent from exact approvedModelIds gate');
  }
  return Object.freeze({
    baseCommit,
    candidate,
    defaults: { isEnabled: false },
    nextMigrationVersion,
    operation: 'EVIDENCE_PLAN',
    requiredHumanWork: Object.freeze([
      'author and review static registry entry',
      'author both migration registrations and faithful down migration',
      'author and run real PGlite migration coverage',
    ]),
    writes: false,
  });
}
