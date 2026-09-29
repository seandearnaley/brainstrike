import type { Migration } from './migration-runner.js';

// BST-1697. Four OpenRouter routes stopped resolving in
// https://openrouter.ai/api/v1/models (checked 2026-09-08 and again
// 2026-09-09), so they are deleted from the DB catalog to match the removal
// from provider-catalog.json in the same change.
//
// A hard DELETE is FK-safe: no table declares a foreign key to `models(id)`
// (`grep -rn "REFERENCES models" packages/db/src/migrations/*.ts` finds
// nothing). Historical run provenance — `brainstrike_assistant_thread_runs.model`
// and `brainstrike_assistant_run_usage.model` — is plain text with no
// constraint, and this migration deliberately does not touch it, so
// conversation history keeps naming the model that actually served each run
// (docs/agents/database.md rule 4 and the BST-566 runbook).
//
// The DELETE keys on `id` alone (as migration 119's own down does) because
// `models.id` is the primary key and the upsert conflict target, so it is
// already exact. Adding a redundant `provider_id = 'openrouter'` predicate
// would also make scripts/model-catalog-migration-contract.mjs read the
// statement as a WHOLE-PROVIDER deletion and drop every OpenRouter row from
// its reconstructed snapshot.
//
// SORT ORDER: the single-row retirements (098, 107, …) shift the remaining
// rows by a hard-coded ±1, which cannot express four deletions scattered
// through the openrouter block — the correct offset depends on how many of the
// four a given profile actually holds and on where each one sits. Both
// directions therefore use one set-based `row_number()` renumber, which lands
// on a gap-free 1..N ordering from ANY starting state, including a profile
// that never received some of these rows.
//
// That renumber partitions by `provider_id` instead of filtering to
// `provider_id = 'openrouter'` for two reasons. Semantically it says the
// invariant it is restoring — every provider's rows are numbered 1..N with no
// gaps — and the `sort_order <> next_sort_order` guard makes it a no-op for
// every provider this migration does not touch (asserted in
// migration-121-retire-delisted-openrouter-models.test.ts). Mechanically, the
// contract checker's whole-provider DELETE pattern in
// scripts/model-catalog-migration-contract.mjs is an unanchored regex that
// scans past the statement terminator, so a literal
// `provider_id = 'openrouter'` anywhere after the DELETE makes it read this
// migration as deleting the entire OpenRouter provider (BST-1703).
//
// The `down` is test-only (BrainStrike ships no production rollback path). It
// restores each row with the name/tagline/best_for/capabilities it shipped
// with in migrations 071, 072, 098 and 107, appended after the surviving rows
// and then renumbered; `is_enabled` seeds false because a rollback cannot know
// what toggle the deleted row carried.
/** Delete the four OpenRouter routes delisted in the September 2026 refresh. */
export const migration121RetireDelistedOpenRouterModels: Migration = {
  down: `
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'stealth/ox-alpha',
        'openrouter',
        'Ox Alpha (OpenRouter)',
        NULL,
        '[]',
        '{"type":"llm","streaming":true,"vision":true}',
        (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM models WHERE provider_id = 'openrouter'),
        false
      ),
      (
        'qwen/qwen3.8-max',
        'openrouter',
        'Qwen3.8 Max (OpenRouter)',
        'Flagship multimodal reasoning with a 1M-token context window',
        '["Long-context work", "Multimodal reasoning", "Tool calling"]',
        '{"type":"llm","streaming":true,"vision":true}',
        (SELECT COALESCE(MAX(sort_order), 0) + 2 FROM models WHERE provider_id = 'openrouter'),
        false
      ),
      (
        'inclusionai/ling-3.0-flash:free',
        'openrouter',
        'Ling 3.0 Flash Free (OpenRouter)',
        'Efficient agentic model from InclusionAI',
        '["Agentic workflows", "Tool use", "Cost-sensitive tasks"]',
        '{"type":"llm","streaming":true,"vision":false}',
        (SELECT COALESCE(MAX(sort_order), 0) + 3 FROM models WHERE provider_id = 'openrouter'),
        false
      ),
      (
        'kwaipilot/kat-coder-air-v2.5',
        'openrouter',
        'KAT-Coder Air V2.5 (OpenRouter)',
        'Efficient autonomous coding model',
        '["Issue resolution", "Repository editing", "Tool use"]',
        '{"type":"llm","streaming":true,"vision":false}',
        (SELECT COALESCE(MAX(sort_order), 0) + 4 FROM models WHERE provider_id = 'openrouter'),
        false
      )
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;
    WITH ordered AS (
      SELECT
        id,
        row_number() OVER (PARTITION BY provider_id ORDER BY sort_order, id) AS next_sort_order
      FROM models
    )
    UPDATE models
    SET sort_order = ordered.next_sort_order
    FROM ordered
    WHERE models.id = ordered.id
      AND models.sort_order <> ordered.next_sort_order;
  `,
  ledgerKey: 'custom-121-retire-delisted-openrouter-models',
  name: 'retire_delisted_openrouter_models',
  up: `
    DELETE FROM models
    WHERE id IN (
      'stealth/ox-alpha',
      'qwen/qwen3.8-max',
      'inclusionai/ling-3.0-flash:free',
      'kwaipilot/kat-coder-air-v2.5'
    );
    WITH ordered AS (
      SELECT
        id,
        row_number() OVER (PARTITION BY provider_id ORDER BY sort_order, id) AS next_sort_order
      FROM models
    )
    UPDATE models
    SET sort_order = ordered.next_sort_order
    FROM ordered
    WHERE models.id = ordered.id
      AND models.sort_order <> ordered.next_sort_order;
  `,
  version: 121,
};
