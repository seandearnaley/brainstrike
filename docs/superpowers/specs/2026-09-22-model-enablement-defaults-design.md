# BST-1794 — Model enablement defaults: a catalog addition must be able to reach an existing profile

**Ticket:** BST-1794 · **Date:** 2026-09-22 · **Status:** draft for review · **Scope:** `initializeProviderModelDefaults` in `packages/app-state/src/stores/model-registry-store.ts` and the three `packages/app-shell/src/hooks/use-*-model-defaults.ts` hooks. No migration, no schema change, no catalog edit.

This document is the research-and-design output. The task-by-task implementation
plan is written after this is approved (writing-plans step).

## 1. Problem, grounded

### 1.1 Seven catalog models are unreachable in the composer

`provider-catalog.json` declares 13 `openai`, 7 `anthropic` and 10 `google` LLM
rows. On a profile that has run any recent build, these seven cannot be selected
in the composer at all:

| Provider | Model | Shipped by |
| --- | --- | --- |
| openai | `gpt-6-astra` | migration 123 |
| anthropic | `claude-opus-5` | migration 116 |
| anthropic | `claude-fable-5-1` | migration 122 |
| google | `gemini-3.8-flash` | migration 124 |
| google | `gemini-3.7-flash` | migration 124 |
| google | `gemini-3.6-flash` | migration 124 |
| google | `gemini-3.5-flash-lite` | migration 124 |

They are present in the catalog, present in the `models` table, and priced,
tagged and typed correctly. They are simply `is_enabled = false` with nothing in
the system able to change that except a manual toggle in Settings → Models.

Derivation: every numbered migration's `INSERT INTO models` / `DELETE FROM
models` was parsed in file order to produce the final `(id, provider_id,
is_enabled)` state, then cross-joined against the catalog's LLM rows.
Spot-checked by hand against migrations 116, 122, 123 and 130.

### 1.2 Why a new row can never light up

Every model migration since 015 seeds `is_enabled = false` and preserves the
user's toggle on re-apply with `is_enabled = models.is_enabled`
(`122-anthropic-bedrock-catalog-models.ts:57`; database.md rule 3). That rule is
correct and is not in question here.

The only code that can turn a row on without the user is
`initializeProviderModelDefaults`
(`packages/app-state/src/stores/model-registry-store.ts:335`), reached through
three per-provider hooks composed in `use-provider-model-defaults.ts`. It opens
with a provider-wide early return
(`model-registry-store.ts:347`):

```ts
function hasExplicitProviderModelChoice(rows) {
  let hasExplicitChoice = false;
  for (const row of rows) {
    hasExplicitChoice ||= Boolean(row.is_enabled) || updatedAt > createdAt;
  }
  return hasExplicitChoice;
}
```

`Boolean(row.is_enabled)` is the defect. `is_enabled` carries two different
facts — *we shipped this on* and *the user turned this on* — and this predicate
cannot distinguish them. Consequences:

- **anthropic / openai / google** ship rows `true` from migrations 033 and 057,
  so the predicate is already satisfied on a **brand-new** profile. Adding a
  `useAnthropicDefaults` hook in the current shape would return `'preserved'` on
  its first tick and never do anything. *The missing per-provider hook is not the
  bug.*
- **openrouter / bedrock / openai-codex** ship every row `false`, so their hooks
  do fire — exactly once, on first connect. The moment the user enables anything,
  the provider is latched and no later addition can be introduced either.

So the accurate statement of the defect is:

> There is no mechanism in the system that can make a newly-added catalog model
> reachable on a profile that already exists. The defaults hooks are first-run
> seeding for providers whose rows all ship disabled, and are structurally
> incapable of introducing a later addition.

This is why the fix is not "add three more hooks".

### 1.3 The signal that makes a precise fix possible

Catalog upserts deliberately do **not** touch `updated_at`; the column is written
only by `toggleModel` and by `initializeProviderModelDefaults` itself. So
`updated_at > created_at` is a clean, already-persisted record of *the user
touched this row*, per row, with no schema change required.

### 1.4 Not in scope, and why

- **Dynamic `/models` discovery.** Real and separately worth doing — dynamic
  discovery exists today only for local runtimes (`packages/local-runtime/`
  probes `/v1/models`, `/api/v1/models`, `/api/tags`); hosted and gateway
  providers are entirely hand-curated, at roughly 13 PRs in the last month.
  Tracked by BST-1359. It would reduce the rate at which dark rows are created;
  it would not make one reachable.
- **The composer picker has no search.** `ComposerModelMenu` is a three-deep
  Radix submenu with no search box, while the fuller `packages/ui/src/model-picker`
  (which has one) is used only by db-explorer and the embedding-set dialogs.
  This change makes that worse by design — see §5. Filed separately.
- **The preferences fallback.** `buildEnabledModelIdSet` reads
  `enabledModelsByProvider` from localStorage instead of the DB when
  `shouldFallbackToPreferences` — a degraded path taken only when PGlite is
  unavailable or errored. Untouched here.

## 2. Design

### 2.1 Two kinds of default, named apart

One mechanism is doing two jobs. Split them:

| Policy | Providers | Meaning |
| --- | --- | --- |
| `all` | openai, anthropic, google | **Availability policy.** Every LLM row for this provider is on unless the user said otherwise. Standing — re-evaluated on every connect, so a future catalog addition lights up with no further edits. |
| `seed` | openrouter, bedrock, openai-codex | **Starter kit.** A curated list applied once, only while the provider's rows are entirely untouched. Behaviour unchanged. |

The split is load-bearing, not cosmetic. Re-applying a *curated subset* over a
profile the user has already curated is presumptuous: an OpenRouter user who
picked 3 of 58 routes should not silently acquire the recommended 5. "Everything
unless you said no" carries no equivalent risk, because it has no opinion to
impose beyond what the catalog already ships.

Accepted consequence: `deepseek/deepseek-v4.1-flash` (migration 130) and every
other post-seed OpenRouter addition stay opt-in. Under a `seed` policy that is
the correct answer, not residue.

`all` deliberately does **not** reuse the catalog's existing `default: true`
flag. That flag marks one model per provider as the *fallback selection* and is a
different concept; reusing it would mean connecting Anthropic yields Sonnet 5 and
nothing else.

### 2.2 The store action

```ts
export type ProviderModelDefaultPolicy =
  | { kind: 'all' }
  | { kind: 'seed'; modelIds: readonly string[] };

initializeProviderModelDefaults(
  db: DbHandle,
  providerId: string,
  policy: ProviderModelDefaultPolicy
): Promise<'initialized' | 'preserved'>
```

The existing per-provider query already selects `id, is_enabled, created_at,
updated_at`. Add `capabilities` so `all` can scope itself to `type = 'llm'`:
embedding enablement has its own settings surface and must not move.

```ts
const untouched = (row) => !row.is_enabled && updatedAt(row) === createdAt(row);
```

- `seed` → keeps `hasExplicitProviderModelChoice` **verbatim**, then the existing
  id-list update. Zero behaviour change for openrouter, bedrock and openai-codex.
- `all` → update every untouched LLM row for the provider; `'preserved'` when
  that set is empty.
- The `missingModelIds` throw stays for `seed`, where it is a real catalog/DB
  drift tripwire. It is dropped for `all`, whose ids come from the DB itself, so
  drift is impossible by construction.

`untouched` requires **both** conjuncts. `updated_at === created_at` alone would
suffice on paper; requiring `!is_enabled` as well means the predicate can only
ever turn a model **on**. No code path introduced by this change can revoke a
model the user is currently using — a structural guarantee worth more than the
redundancy costs.

Rows that are enabled in the DB but absent from the static catalog
(`claude-sonnet-4-5`, `gpt-5.2-chat-latest`, `gemini-3-pro-preview` and two
others — historical residue) are `is_enabled = true`, so `untouched` is false and
they are left exactly as they are. They do not render regardless: the picker
iterates the static registry via `getProviderLlmModels`, and a DB row with no
registry entry has nothing to render.

### 2.3 One hook over an exhaustive policy map

`use-openrouter-model-defaults.ts`, `use-bedrock-model-defaults.ts` and
`use-openai-codex-model-defaults.ts` are ~90 lines each and near-identical; the
Codex hook's own comment already records the intent — *"asymmetry between the
disabled-by-default providers is a bug, not a customization."* Adding three more
copies would make six copies of one effect.

They collapse into a single hook driven by a policy table:

```ts
const PROVIDER_MODEL_DEFAULT_POLICIES = {
  anthropic: { kind: 'all' },
  bedrock: { kind: 'seed', modelIds: BEDROCK_RECOMMENDED_MODEL_IDS },
  google: { kind: 'all' },
  openai: { kind: 'all' },
  'openai-codex': { kind: 'seed', modelIds: OPENAI_CODEX_RECOMMENDED_MODEL_IDS },
  openrouter: { kind: 'seed', modelIds: OPENROUTER_RECOMMENDED_CODING_MODEL_IDS },
} as const satisfies Record<CatalogDefaultProvider, ProviderModelDefaultPolicy>;
```

`CatalogDefaultProvider` is **derived, not listed** — the providers for which
catalog defaults are a meaningful concept are exactly those with
`authType !== 'none'` and `capabilities.llm === true`. Today that resolves to
these six and nothing else: `cohere` and `voyage` are keyed but embedding-only
(`llm: false`), and `local` / `ollama` / `lmstudio` are keyless. Deriving the
domain rather than hand-listing it keeps the feature-gating rule ("capability-based,
never a hardcoded provider list") intact, and means a new provider joins or skips
the map by what it declares.

The `satisfies` is the durable half of the fix: a provider that enters that
derived domain cannot compile without stating its policy, which is precisely the
omission that produced this bug. The per-provider error copy ("OpenAI (ChatGPT) model setup failed")
becomes a per-policy lookup keyed by provider display name; the once-per
`{db, secretsVersion}` attempt guard, the `providerReadErrors` gate and the
`configuredProviders.includes(...)` connection gate are preserved per provider.

`local`, `ollama` and `lmstudio` are outside the map: they are keyless and their
enablement comes from runtime discovery and the downloaded-model set, not from
catalog defaults.

**What makes `all` "standing".** The attempt guard is a `useRef` keyed on
`{db, secretsVersion}`, so the effect dispatches at most once per app session
(and again if credentials change). That is the mechanism: a user who updates the
app, receives migration N's new row, and launches, gets it evaluated on that
launch. No polling, no extra write on subsequent renders, and a `'preserved'`
result costs one SELECT.

## 3. Testing

RED first. The test that states the bug:

> An anthropic profile holding the migration-057 rows enabled and `claude-opus-5`
> shipped `false` → after the hook runs, `claude-opus-5` is enabled.

It fails on `main` today, for the reason in §1.2.

Store (`packages/app-state/src/__tests__/model-registry-store.test.ts`):

1. `all`: untouched disabled row → enabled.
2. `all`: row the user disabled (`updated_at > created_at`) → stays disabled.
3. `all`: row already enabled → untouched, and not counted as a change.
4. `all`: embedding rows are never moved.
5. `all`: no untouched rows → `'preserved'`, no write, no `syncDurableDatabaseWrites`.
6. `seed`: a provider with one enabled row → `'preserved'`. Pins the no-change
   guarantee for openrouter/bedrock/codex.
7. `seed`: missing id still throws.

Hook (`packages/app-shell/src/hooks/use-provider-model-defaults.test.tsx` —
co-located, matching the three files it replaces):

8. Each of the six providers dispatches its declared policy exactly once per
   `{db, secretsVersion}`.
9. A provider absent from `configuredProviders` dispatches nothing.
10. A `providerReadErrors` entry for a provider suppresses only that provider.
11. A rejected dispatch raises that provider's destructive toast and does not
    suppress the others.

Per the mutate-every-guard rule, tests 2, 4 and 6 are each mutated to confirm
they fail when the corresponding conjunct is removed.

## 4. Files

| File | Change |
| --- | --- |
| `packages/app-state/src/stores/model-registry-store.ts` | `ProviderModelDefaultPolicy`; per-row `untouched`; `capabilities` in the choice query; `hasExplicitProviderModelChoice` retained for `seed`. |
| `packages/assistant-contract/src/provider-model-default-policies.ts` | New. The policy map and its `satisfies`. |
| `packages/app-shell/src/hooks/use-provider-model-defaults.ts` | Becomes the single hook. |
| `packages/app-shell/src/hooks/use-{openrouter,bedrock,openai-codex}-model-defaults.ts` | Deleted. |
| `docs/agents/assistant-providers.md` | New subsection under "Provider catalog data ownership" recording the `all`/`seed` split and why `is_enabled` alone is not evidence of user intent. |

## 5. Known consequence

`all` puts roughly 30 first-party models into the composer's three-deep submenu,
which has no search. This change makes the picker the next thing to fix rather
than a nice-to-have. That is accepted deliberately and filed as BST-1795; it is
not a reason to ship a narrower policy, because a shorter menu of the *wrong*
models is the defect being fixed.
