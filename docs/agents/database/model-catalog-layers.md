# Model catalog layer-by-layer record — evidence

Supports `docs/agents/database.md` § "MODEL CATALOG MIGRATIONS".

The full text of the eight catalog rules as they stood before distillation, including the BST-1650 JSON move, the generator's refusals, the BST-565 migration-notice rationale, and the drizzle-parity allowlist. Read before changing a catalog rule or the generator.

The record below is the original contract text, extracted unchanged.

Adding, removing, or renaming a supported AI model is a multi-layer change. Updating only the static catalog is NOT enough — the in-app model picker is driven by a DB-backed catalog.

When changing the model catalog:
1. Update the static provider catalog (single source of truth):
   - packages/assistant-contract/src/provider-catalog.json
   - The catalog is DATA (BST-1650), not a TypeScript literal. `scripts/model-catalog-migration-contract.mjs` and `scripts/__tests__/provider-env-keys-mirror-contract.test.mjs` read it with `JSON.parse`; the earlier requirement to keep `PROVIDER_DEFINITIONS` AST-parseable (BST-1143) is retired, and no catalog field may reference a constant, because JSON cannot. Comments moved to optional `_note` strings, which `parseProviderCatalog` strips before any consumer sees a definition.
   - Because JSON widens under `resolveJsonModule`, `tsc` no longer checks catalog rows: `packages/assistant-contract/src/provider-catalog-schema.ts` does, at module load, and THROWS. It is a `strictObject` schema, so an unknown or misspelled key fails rather than being dropped. `provider-catalog-schema.test.ts` pins the schema against the `ProviderDefinition` / `LlmModelDefinition` / `EmbeddingModelDefinition` interfaces in BOTH directions, so schema-vs-type drift is a type-check failure.
   - `packages/assistant-contract/src/provider-registry.ts` keeps the types and the accessors — it no longer carries a single row, so a new field must be added to the schema AND the interface in the same change (data ownership and the schema/type synchronisation invariant: docs/agents/assistant-providers.md, "Provider catalog data ownership"). A catalog-only edit still re-hashes the package and everything downstream of it — Turbo hashes JSON inputs exactly like `.ts` inputs (measured in BST-1650). The move buys reviewability and script access, NOT build time.
2. Add a numbered DB migration that upserts/deletes catalog rows with a `ledgerKey`, and add it to `packages/db/src/migrations/index.ts` at its ascending-`version` position; the Drizzle ledger is derived. INSERT, never append: `migrate.ts` applies the derived array in ARRAY order, so a rebase resolved by appending the incoming entry silently inverts the apply order (BST-1714 — `main` shipped 123 ahead of 122). Biome's sort-imports rule keeps the import list above the array ordered; only `migration-manifest-order.test.ts` keeps the array itself ordered.
   - For pure ADDITIONS, generate it: `node scripts/gen-model-catalog-migration.mjs` prints the plan and `--write` emits the numbered file and registers it in the manifest (BST-1650). It derives only what the catalog carries — id, provider, name from `label`, `capabilities` from `type`/`supportsStreaming`/`vision`/`defaultDimension` — appends `sort_order` in SQL at apply time, seeds `is_enabled` false, and writes the `is_enabled = models.is_enabled` upsert. `tagline` and `best_for` are left NULL for a human to author per rule 7; the generator never copies the registry's composer tagline into them.
   - It is ADD-ONLY and refuses to run when a catalog row disappeared, because a removal needs the rule-4 remap decisions and a user-visible notice (BST-565) first. An entire provider leaving the catalog is that same removal, not residue: the generator and the contract checker share `isHistoricalCatalogResidue`, whose only exemptions are the pre-021 `transformers` rows (migration 021 renamed that provider with an `UPDATE` the operation extractor does not model) and the checker's `STATIC_CATALOG_STALE_ROW_ALLOWLIST`, so the two tools can never disagree about which rows are reconstruction residue.
   - It also refuses a catalog row that reuses an id the DB catalog already holds under a different provider or type — `models.id` is the upsert's conflict target, so the generated migration would overwrite a live row going up and DELETE a pre-existing one going down — and refuses a model whose `vision`, `supportsStreaming` or `defaultDimension` is missing rather than guessing a capability. `scripts/__tests__/gen-model-catalog-migration.test.mjs` feeds a generated migration back through the contract checker.
   - `ledgerKey` is the persisted `__drizzle_migrations.hash` and must never change once shipped.
   - `packages/db/src/drizzle/migrate.ts` derives `customMigrations` from the numbered manifest, excluding 001–014, 016–019, 029, and 031 folded into the immutable drizzle-kit snapshot. Migration 008 remains numbered-only (ADR-0002).
   - Unfolded migrations must have SQL-string `up`; derivation throws for callbacks. Folded callbacks remain numbered-runner-only.
   - Paired tests: `packages/db/__tests__/drizzle-ledger-keys.test.ts` freezes the 95 shipped keys and verifies old-ledger startup applies nothing; `drizzle-migration-manifest.test.ts` proves automatic registration and fail-closed callback rejection. `scripts/__tests__/model-catalog-migration-contract.test.mjs` preserves the numbered-registration guard. `migration-manifest-order.test.ts` (BST-1714) pins both the manifest and the derived `customMigrations` to strictly ascending `version`, naming the offending pair when it fails, and pins `baseMigrations` to exactly 001–003 — that second array in the same file is why a naive "sort every `  migrationNNN,` line" pass corrupts rather than fixes.
3. Preserve user choices on kept rows with `ON CONFLICT (id) DO UPDATE SET ... is_enabled = models.is_enabled`.
   - INVARIANT: never use `is_enabled = EXCLUDED.is_enabled` for a catalog refresh — it clobbers the user's toggle. Force on/off only for a deliberate (e.g. security) swap.
4. Remap dropped IDs in the preference stores so persisted selections don't dangle:
   - MODEL_ID_MIGRATIONS in packages/app-state/src/stores/assistant-model-id-migrations.ts (bump `ASSISTANT_PREFERENCES_STORE_VERSION` in `assistant-preferences-store-version.ts`)
   - A remap that changes the user's SELECTED model is not silent: the
     persist migration records it in session-only `modelMigrationNotices`
     and `useModelMigrationNotices` (mounted once in app-shell's `AppLayout`)
     takes-and-clears it into one toast (BST-565 — an OpenRouter Pro → Flash
     swap is a capability downgrade the user must see). Retired defaults under
     providers the user is not running on, and enabled-list-only remaps, stay
     quiet: `modelsByProvider` is seeded for every provider and is not
     evidence of intent.
   - MEMORY_MODEL_TARGET_MIGRATIONS in packages/app-state/src/stores/assistant-memory-preferences-store.ts (also self-heals on every rehydration)
   - The guard canonicalizes discovered migration identifiers with
     `path.posix.join` so diagnostics and downstream checks are platform-neutral.
     Its version parser still accepts `/` or `\` for direct analyzer callers and
     fixtures, preventing Windows paths from misclassifying historical deletions
     as new remap obligations.
5. Add new `packages/db/__tests__/**/*.test.{ts,tsx}` files without a lane-registry edit. The `unit` Vitest project discovers that tree recursively; required Unit and nightly coverage both supply the complete `DB_TEST_SHARD=1/2` + `2/2` set to that project, where Vitest applies its native shard. The value is a DB-task environment input, never a Turbo CLI passthrough argument. Nightly rejoins Vitest blob reports with `--merge-reports`, so coverage is one native union rather than whichever serial lane wrote last. `scripts/__tests__/db-test-discovery-contract.test.mjs` pins the recursive include, browser exclusion, nested discovery, and a minimum 150-file floor, with mutations proving each assertion can fail. The former regex manifest and its two derived lane scripts were deleted in BST-1046; do not recreate a registration map for test placement.
6. Every LLM model entry MUST declare `contextWindow` (and `maxOutputTokens` when documented) in
   packages/assistant-contract/src/provider-catalog.json — schema-enforced at module load
   (BST-1650 moved this from a compile error to a `parseProviderCatalog` throw; it still fails
   closed, and any test that imports the registry surfaces it), static-registry-only (no DB
   migration). It drives the thread context meter and the auto-derived
   `agentLoop.inputTokenLimit` (see packages/assistant-contract/src/context-budget.ts).
7. `tagline` on a registry LLM entry is OPTIONAL, registry-only composer copy: it renders as
   the model's one-line description in the composer model menu. The DB catalog's own
   tagline/description column feeds the db-explorer surface instead — the two are separate
   sources on purpose (no migration needed for registry tagline changes). Omit rather than
   invent copy: taglineless models render name-only.
8. Every LLM model entry MUST also declare `vision` ('supported' | 'unsupported'; never
   'unknown' in the static registry — schema-enforced as above, and pinned by
   provider-registry-vision.test.ts). It gates the
   composer image-attachment affordance per selected model. Unlike `contextWindow`, this one IS
   mirrored into the DB catalog: new model rows must include `"vision"` in the capabilities
   jsonb (migration 061 backfilled existing rows), and frontier-models-migration.test.ts fails
   if any LLM row is left without a vision value.

The Drizzle runner is the sole production migration authority; the numbered runner is `schema-validation-only`, as enforced by `packages/db/src/architecture/db-migration-authority.ts`.

Three schema differences pre-date BST-1643: Drizzle-only `embedding_cache` (8 columns) and `token_cache` (5 columns), and numbered-only `file_records.embedding`. `packages/db/__tests__/drizzle-migration-parity.integration.test.ts` freezes these in a shrink-only allowlist, requiring equality elsewhere and proving the exceptions still diverge. Reconciling them is separate work: follow-up ticket to be filed.
