import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const slugify = (id) => id.replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-|-$/gu, '');
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
  if (!source?.safeAddition?.approvedModelIds?.includes(candidate.modelId)) {
    throw new Error('candidate is absent from exact approvedModelIds gate');
  }
  const version = String(nextMigrationVersion).padStart(3, '0');
  const slug = slugify(candidate.modelId);
  return Object.freeze({
    baseCommit,
    candidate,
    defaults: { isEnabled: false },
    nextMigrationVersion,
    operation: 'PLAN',
    paths: [
      'packages/assistant-contract/src/provider-registry.ts',
      `packages/db/src/migrations/${version}-openrouter-add-${slug}.ts`,
      'packages/db/src/migrations/index.ts',
      'packages/db/src/drizzle/migrate.ts',
      `packages/db/__tests__/migration-${version}-openrouter-add-${slug}.test.ts`,
    ],
    verification: ['pnpm lint:model-catalog-migrations', 'pnpm test:scripts'],
  });
}
function generated(path, plan) {
  const id = plan.candidate.modelId;
  const version = String(plan.nextMigrationVersion).padStart(3, '0');
  if (path.includes(`/migrations/${version}-`)) {
    return `// Generated PLAN only; review before applying.\nexport const modelId = ${JSON.stringify(id)};\nexport const upSql = ${JSON.stringify(`UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter'; INSERT INTO models (id, provider_id, name, capabilities, sort_order, is_enabled) VALUES ('${id}', 'openrouter', '${id}', '{"type":"llm","streaming":true}', 1, false) ON CONFLICT (id) DO UPDATE SET provider_id = EXCLUDED.provider_id, name = EXCLUDED.name, capabilities = EXCLUDED.capabilities, sort_order = EXCLUDED.sort_order, is_enabled = models.is_enabled;`)};\nexport const downSql = ${JSON.stringify(`DELETE FROM models WHERE provider_id = 'openrouter' AND id = '${id}'; UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';`)};\n`;
  }
  if (path.includes('/__tests__/')) {
    return `// Generated PLAN test placeholder for ${id}; must run real PGlite before application.\n`;
  }
  return null;
}
export function renderSafeAdditionEdits({ plan, files }) {
  if (plan.operation !== 'PLAN') {
    throw new Error('safe addition renderer accepts PLAN only');
  }
  const edits = plan.paths.map((path) => {
    const previous = files.get(path);
    const fresh = generated(path, plan);
    if (fresh === null && typeof previous !== 'string') {
      throw new Error(`missing guarded base file: ${path}`);
    }
    const content =
      fresh ??
      `${previous}\n// MODEL_CATALOG_PLAN ${plan.nextMigrationVersion}: add ${plan.candidate.modelId}; human AST application required.\n`;
    return {
      content,
      expectedSha256: typeof previous === 'string' ? sha256(previous) : null,
      path,
    };
  });
  return {
    baseCommit: plan.baseCommit,
    candidateEvidence: plan.candidate.evidence,
    edits,
    operation: 'PLAN',
    verification: plan.verification,
    writes: false,
  };
}
