# BST-1794 Model Enablement Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a newly-added catalog model reachable on a profile that already exists, by testing enablement per row instead of per provider.

**Architecture:** `initializeProviderModelDefaults` currently early-returns on a provider-wide predicate that treats a shipped-enabled row as user intent, so it can only ever seed a virgin provider. Replace it with two named policies — `all` (availability: every untouched LLM row is on) for openai/anthropic/google, and `seed` (starter kit: today's behaviour, byte-for-byte) for openrouter/bedrock/openai-codex — selected from one exhaustive policy map, and collapse the three near-identical per-provider hooks into one hook driven by that map.

**Tech Stack:** TypeScript strict (no `any`), React 19, Zustand, PGlite via `DbHandle`, Vitest. pnpm workspaces / Turborepo.

Spec: `docs/superpowers/specs/2026-09-22-model-enablement-defaults-design.md`
Branch: `seandearnaley/bst-1794-a-newly-added-catalog-model-can-never-reach-an-existing`

## Global Constraints

- Every commit message and the PR description carry `BST-1794`. PR description must contain the identifier in exact `BST-###` form (ci-quality.md).
- TypeScript strict. **Never `any`** — prefer `unknown` + narrowing. Annotate parameters and return types. Discriminated unions over enums.
- Filenames kebab-case. Hooks are `use-*.ts` exporting camelCase.
- **No migration, no schema change, no edit to `provider-catalog.json`** in this plan. If a task seems to need one, stop and re-read the spec.
- `is_enabled` is user state. No code introduced here may set a row to `false`. The `untouched` predicate requires `!is_enabled` precisely so the only reachable transition is off → on.
- Biome/Ultracite: object keys sorted alphabetically, block statements required. Run `pnpm dlx ultracite fix` before each commit.
- Tests live beside the code they test in this area: store tests in `packages/app-state/src/__tests__/`, app-shell hook tests co-located as `packages/app-shell/src/hooks/<name>.test.tsx`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/assistant-contract/src/provider-model-default-policies.ts` | **New.** The `ProviderModelDefaultPolicy` union and the exhaustive `PROVIDER_MODEL_DEFAULT_POLICIES` map. Data + type only, no I/O. |
| `packages/assistant-contract/src/__tests__/provider-model-default-policies.test.ts` | **New.** Pins the map against the catalog: `null` iff `authType === 'none' \|\| !capabilities.llm`; every `seed` id exists in that provider's registry entry. |
| `packages/assistant-contract/src/index.ts` | Re-export the new module. |
| `packages/app-state/src/stores/model-registry-store.ts` | The action takes a policy; `seed` keeps the provider-wide gate verbatim, `all` filters per row. |
| `packages/app-state/src/__tests__/model-registry-store.test.ts` | Extend the existing `initializeProviderModelDefaults` describe block. |
| `packages/app-shell/src/hooks/use-provider-model-defaults.ts` | Becomes the single hook, iterating the policy map. |
| `packages/app-shell/src/hooks/use-provider-model-defaults.test.tsx` | **New.** Replaces the three per-provider hook test files. |
| `packages/app-shell/src/hooks/use-{openrouter,bedrock,openai-codex}-model-defaults.{ts,test.tsx}` | **Deleted** in Task 4. |
| `docs/agents/assistant-providers.md` | New subsection recording the `all`/`seed` split. |

Task order is dependency order: contract (1) → store (2) → hook (3) → deletion + docs (4). Tasks 1–3 each leave the tree green; Task 4 removes the old code once nothing imports it.

---

### Task 1: The policy contract

**Files:**
- Create: `packages/assistant-contract/src/provider-model-default-policies.ts`
- Create: `packages/assistant-contract/src/__tests__/provider-model-default-policies.test.ts`
- Modify: `packages/assistant-contract/src/index.ts`

**Interfaces:**
- Consumes: `BEDROCK_RECOMMENDED_MODEL_IDS`, `OPENAI_CODEX_RECOMMENDED_MODEL_IDS`, `OPENROUTER_RECOMMENDED_CODING_MODEL_IDS` (existing), `SupportedProvider`, `listProviders` from `provider-registry.js`.
- Produces:
  - `type ProviderModelDefaultPolicy = { kind: 'all' } | { kind: 'seed'; modelIds: readonly string[] }`
  - `const PROVIDER_MODEL_DEFAULT_POLICIES: Record<SupportedProvider, ProviderModelDefaultPolicy | null>`
  - `function getProviderModelDefaultPolicy(provider: SupportedProvider): ProviderModelDefaultPolicy | null`

- [ ] **Step 1: Write the failing test**

Create `packages/assistant-contract/src/__tests__/provider-model-default-policies.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { listProviders } from '../provider-registry.js';
import {
  getProviderModelDefaultPolicy,
  PROVIDER_MODEL_DEFAULT_POLICIES,
} from '../provider-model-default-policies.js';

describe('PROVIDER_MODEL_DEFAULT_POLICIES', () => {
  it('covers every provider in the catalog', () => {
    const catalogIds = listProviders()
      .map((provider) => provider.id)
      .sort();
    expect(Object.keys(PROVIDER_MODEL_DEFAULT_POLICIES).sort()).toEqual(catalogIds);
  });

  it('is null exactly for providers that cannot have catalog defaults', () => {
    // Derived, not listed: a provider has catalog defaults only when it is
    // keyed AND serves LLMs. Keyless runtimes get enablement from discovery;
    // embedding-only providers have no LLM rows to enable.
    for (const provider of listProviders()) {
      const expectsNull = provider.authType === 'none' || !provider.capabilities.llm;
      expect({
        id: provider.id,
        isNull: PROVIDER_MODEL_DEFAULT_POLICIES[provider.id] === null,
      }).toEqual({ id: provider.id, isNull: expectsNull });
    }
  });

  it('gives the three first-party keyed providers an availability policy', () => {
    for (const id of ['anthropic', 'google', 'openai'] as const) {
      expect(getProviderModelDefaultPolicy(id)).toEqual({ kind: 'all' });
    }
  });

  it('declares every seed id in that provider\'s own registry entry', () => {
    for (const provider of listProviders()) {
      const policy = PROVIDER_MODEL_DEFAULT_POLICIES[provider.id];
      if (policy?.kind !== 'seed') {
        continue;
      }
      const registryIds = new Set(provider.models.map((model) => model.id));
      const unknown = policy.modelIds.filter((modelId) => !registryIds.has(modelId));
      expect({ id: provider.id, unknown }).toEqual({ id: provider.id, unknown: [] });
    }
  });

  it('never declares an empty seed set', () => {
    for (const policy of Object.values(PROVIDER_MODEL_DEFAULT_POLICIES)) {
      if (policy?.kind === 'seed') {
        expect(policy.modelIds.length).toBeGreaterThan(0);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @brainstrike/assistant-contract vitest run provider-model-default-policies
```

Expected: FAIL — `Failed to resolve import "../provider-model-default-policies.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/assistant-contract/src/provider-model-default-policies.ts`:

```ts
import { BEDROCK_RECOMMENDED_MODEL_IDS } from './bedrock-defaults.js';
import { OPENAI_CODEX_RECOMMENDED_MODEL_IDS } from './openai-codex-defaults.js';
import { OPENROUTER_RECOMMENDED_CODING_MODEL_IDS } from './openrouter-coding-defaults.js';
import type { SupportedProvider } from './provider-metadata.js';

/**
 * How a provider's DB catalog rows become enabled without the user (BST-1794).
 *
 * - `all` is an AVAILABILITY policy: every LLM row is on unless the user said
 *   otherwise. Standing — re-evaluated each app session, so a model added by a
 *   later migration becomes reachable with no further edits. This is what makes
 *   a catalog addition reach an existing profile.
 * - `seed` is a STARTER KIT: a curated list applied once, only while the
 *   provider's rows are entirely untouched. Re-applying a curated subset over a
 *   profile the user has already curated would be presumptuous, so `seed` keeps
 *   the original provider-wide gate.
 *
 * Consequence recorded deliberately: OpenRouter routes added after the seed
 * (e.g. `deepseek/deepseek-v4.1-flash`) stay opt-in. Under a starter kit that
 * is correct, not residue.
 */
export type ProviderModelDefaultPolicy =
  | { readonly kind: 'all' }
  | { readonly kind: 'seed'; readonly modelIds: readonly string[] };

/**
 * Exhaustive over `SupportedProvider`. `null` means the provider has no catalog
 * defaults at all, which is true exactly when it is keyless (enablement comes
 * from runtime discovery and the downloaded-model set) or serves no LLMs.
 *
 * The `satisfies` is load-bearing: a new provider cannot compile without
 * stating a policy or an explicit `null`. Omitting that decision is what left
 * seven models unreachable in the first place. The `null`-iff rule is pinned by
 * provider-model-default-policies.test.ts against the live catalog rather than
 * restated here as a hand-maintained list.
 */
export const PROVIDER_MODEL_DEFAULT_POLICIES = {
  anthropic: { kind: 'all' },
  bedrock: { kind: 'seed', modelIds: BEDROCK_RECOMMENDED_MODEL_IDS },
  cohere: null,
  google: { kind: 'all' },
  lmstudio: null,
  local: null,
  ollama: null,
  openai: { kind: 'all' },
  'openai-codex': { kind: 'seed', modelIds: OPENAI_CODEX_RECOMMENDED_MODEL_IDS },
  openrouter: { kind: 'seed', modelIds: OPENROUTER_RECOMMENDED_CODING_MODEL_IDS },
  voyage: null,
} as const satisfies Record<SupportedProvider, ProviderModelDefaultPolicy | null>;

/** Non-throwing accessor; `null` for a provider with no catalog defaults. */
export function getProviderModelDefaultPolicy(
  provider: SupportedProvider
): ProviderModelDefaultPolicy | null {
  return PROVIDER_MODEL_DEFAULT_POLICIES[provider];
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/assistant-contract/src/index.ts`, add alongside the existing
`bedrock-defaults` / `openai-codex-defaults` re-exports (keep the file's
existing export ordering convention):

```ts
export * from './provider-model-default-policies.js';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @brainstrike/assistant-contract vitest run provider-model-default-policies
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Mutate the exhaustiveness guard**

Temporarily change `voyage: null` to `voyage: { kind: 'all' }` and re-run.
Expected: the "null exactly for providers that cannot have catalog defaults"
test FAILS, naming `voyage`. Revert the mutation and re-run to green.

An unmutated guard was never verified to guard anything — this step is required, not optional.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm dlx ultracite fix && pnpm --filter @brainstrike/assistant-contract typecheck
```

```bash
git add packages/assistant-contract/src/provider-model-default-policies.ts packages/assistant-contract/src/__tests__/provider-model-default-policies.test.ts packages/assistant-contract/src/index.ts
git commit -m "feat(BST-1794): declare a catalog-default policy for every provider

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Per-row enablement in the store action

**Files:**
- Modify: `packages/app-state/src/stores/model-registry-store.ts` (the `ProviderModelRegistryState` interface near `:55`, `hasExplicitProviderModelChoice` at `:120`, the action at `:335`)
- Test: `packages/app-state/src/__tests__/model-registry-store.test.ts` (extend the existing `describe('initializeProviderModelDefaults')` block at `:533`)

**Interfaces:**
- Consumes: `ProviderModelDefaultPolicy` from Task 1.
- Produces: `initializeProviderModelDefaults(db: DbHandle, providerId: string, policy: ProviderModelDefaultPolicy) => Promise<'initialized' | 'preserved'>`. **Signature change** — the third parameter was `readonly string[]`. Task 3 is the only caller.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('initializeProviderModelDefaults')` block in `packages/app-state/src/__tests__/model-registry-store.test.ts`. Note the existing `untouchedRows` fixture in that block is reused; these add their own rows where they need different shapes.

```ts
    const llmCapabilities = { streaming: true, type: 'llm' } as const;

    it('enables an untouched row the catalog shipped disabled (BST-1794)', async () => {
      // The bug, stated: an anthropic profile holding its migration-057 rows
      // enabled and `claude-opus-5` shipped false. The provider-wide predicate
      // saw one enabled row and preserved everything, so the new model was
      // unreachable forever.
      useModelRegistryStore.setState({
        models: [
          createMockModel({ id: 'claude-sonnet-5', isEnabled: true, providerId: 'anthropic' }),
          createMockModel({ id: 'claude-opus-5', isEnabled: false, providerId: 'anthropic' }),
        ],
      });
      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({
            rows: [
              {
                capabilities: llmCapabilities,
                created_at: '2026-07-22T12:00:00.000Z',
                id: 'claude-sonnet-5',
                is_enabled: true,
                updated_at: '2026-07-22T12:00:00.000Z',
              },
              {
                capabilities: llmCapabilities,
                created_at: '2026-09-04T12:00:00.000Z',
                id: 'claude-opus-5',
                is_enabled: false,
                updated_at: '2026-09-04T12:00:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({ rows: [{ id: 'claude-opus-5' }] }),
        syncToFs: vi.fn(async () => undefined),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'anthropic', { kind: 'all' });

      expect(result).toBe('initialized');
      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('UPDATE models SET is_enabled = true, updated_at = NOW()'),
        ['anthropic', 'claude-opus-5']
      );
      expect(
        useModelRegistryStore.getState().models.find((model) => model.id === 'claude-opus-5')
          ?.isEnabled
      ).toBe(true);
    });

    it('leaves a row the user deliberately disabled switched off', async () => {
      useModelRegistryStore.setState({
        models: [createMockModel({ id: 'gpt-5.4', isEnabled: false, providerId: 'openai' })],
      });
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              capabilities: llmCapabilities,
              created_at: '2026-07-22T12:00:00.000Z',
              id: 'gpt-5.4',
              is_enabled: false,
              // A later updated_at is the durable record of a user toggle;
              // catalog upserts never write this column.
              updated_at: '2026-08-01T09:30:00.000Z',
            },
          ],
        }),
        syncToFs: vi.fn(async () => undefined),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openai', { kind: 'all' });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.syncToFs).not.toHaveBeenCalled();
    });

    it('never touches embedding rows under an availability policy', async () => {
      useModelRegistryStore.setState({
        models: [
          createMockModel({ id: 'text-embedding-3-large', isEnabled: false, providerId: 'openai' }),
        ],
      });
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              capabilities: { defaultDimension: 3072, type: 'embedding' },
              created_at: '2026-07-22T12:00:00.000Z',
              id: 'text-embedding-3-large',
              is_enabled: false,
              updated_at: '2026-07-22T12:00:00.000Z',
            },
          ],
        }),
        syncToFs: vi.fn(async () => undefined),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openai', { kind: 'all' });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('preserves a curated profile under a seed policy', async () => {
      // The other half of the split: a user who picked 3 of 58 OpenRouter
      // routes must not silently acquire the recommended set.
      useModelRegistryStore.setState({
        models: [createMockModel({ id: 'model-a', isEnabled: true, providerId: 'openrouter' })],
      });
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              capabilities: llmCapabilities,
              created_at: '2026-07-22T12:00:00.000Z',
              id: 'model-a',
              is_enabled: true,
              updated_at: '2026-07-22T12:00:00.000Z',
            },
          ],
        }),
        syncToFs: vi.fn(async () => undefined),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
          kind: 'seed',
          modelIds: ['model-a', 'model-b'],
        });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
```

Update the two pre-existing tests in this block to pass a policy instead of an
id array — `initializeProviderModelDefaults(mockDb as never, 'openrouter', { kind: 'seed', modelIds: ['model-a', 'model-b'] })` — and add
`capabilities: llmCapabilities` to each object in the shared `untouchedRows`
fixture at `:534`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @brainstrike/app-state vitest run model-registry-store -t "initializeProviderModelDefaults"
```

Expected: FAIL. The BST-1794 test fails with `expected 'preserved' to be 'initialized'` — the provider-wide predicate sees `claude-sonnet-5` enabled and bails. That is the bug reproduced.

- [ ] **Step 3: Widen the choice row type and the selected columns**

In `packages/app-state/src/stores/model-registry-store.ts`, extend
`RawProviderModelChoice` (near `:102`) with the capabilities column:

```ts
interface RawProviderModelChoice {
  capabilities: string | object;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  created_at: Date | string;
  id: string;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  is_enabled: number | boolean;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  updated_at: Date | string;
}
```

Add the per-row predicates beside the existing `hasExplicitProviderModelChoice`
(which stays exactly as it is — it is the `seed` gate):

```ts
function isLlmChoiceRow(row: RawProviderModelChoice): boolean {
  const capabilities =
    typeof row.capabilities === 'string'
      ? (JSON.parse(row.capabilities) as { type?: unknown })
      : (row.capabilities as { type?: unknown });
  return capabilities.type === 'llm';
}

/**
 * A row no user has ever acted on. Requires BOTH conjuncts: `updated_at ===
 * created_at` alone would be enough on paper, but demanding `!is_enabled` as
 * well means this predicate can only ever select a row to turn ON. No path
 * through the availability policy can revoke a model the user is using.
 */
function isUntouchedChoiceRow(row: RawProviderModelChoice): boolean {
  if (row.is_enabled) {
    return false;
  }
  return (
    timestampMillis(row.updated_at, 'updated_at') === timestampMillis(row.created_at, 'created_at')
  );
}
```

- [ ] **Step 4: Take a policy in the action**

Change the interface member near `:55`:

```ts
  initializeProviderModelDefaults: (
    db: DbHandle,
    providerId: string,
    policy: ProviderModelDefaultPolicy
  ) => Promise<'initialized' | 'preserved'>;
```

Import the type at the top of the file:

```ts
import type { ProviderModelDefaultPolicy } from '@brainstrike/assistant-contract';
```

Replace the action's opening (from `const uniqueModelIds = ...` through the
`missingModelIds` throw) with the policy split. Everything from
`const placeholders = ...` onward is unchanged:

```ts
      initializeProviderModelDefaults: async (db, providerId, policy) => {
        const choiceResult = await db.query<RawProviderModelChoice>(
          `SELECT id, is_enabled, capabilities, created_at, updated_at
           FROM models WHERE provider_id = $1`,
          [providerId]
        );

        let uniqueModelIds: string[];
        if (policy.kind === 'all') {
          // Availability policy: every LLM row nobody has acted on. Ids come
          // from the DB itself, so catalog/DB drift cannot arise here and
          // there is nothing to validate against.
          uniqueModelIds = choiceResult.rows
            .filter((row) => isLlmChoiceRow(row) && isUntouchedChoiceRow(row))
            .map((row) => row.id);
        } else {
          // Starter kit: unchanged behaviour. One enabled or edited row in the
          // provider means the user has curated it; do not impose a set.
          if (hasExplicitProviderModelChoice(choiceResult.rows)) {
            return 'preserved';
          }
          uniqueModelIds = Array.from(new Set(policy.modelIds));
          if (uniqueModelIds.length === 0) {
            throw new Error(`No recommended model defaults were provided for ${providerId}.`);
          }
          const choicesById = new Map(choiceResult.rows.map((row) => [row.id, row]));
          const missingModelIds = uniqueModelIds.filter((modelId) => !choicesById.has(modelId));
          if (missingModelIds.length > 0) {
            throw new Error(
              `Recommended ${providerId} models are missing from the catalog: ${missingModelIds.join(', ')}`
            );
          }
        }

        if (uniqueModelIds.length === 0) {
          return 'preserved';
        }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @brainstrike/app-state vitest run model-registry-store -t "initializeProviderModelDefaults"
```

Expected: PASS, all tests in the block including the four new ones.

- [ ] **Step 6: Mutate each new guard**

Three mutations, reverting after each:

1. Drop `!isUntouchedChoiceRow` → change `isUntouchedChoiceRow` to `return !row.is_enabled;`. Expected: "leaves a row the user deliberately disabled switched off" FAILS.
2. Drop the type scope → change `isLlmChoiceRow` to `return true;`. Expected: "never touches embedding rows" FAILS.
3. Drop the seed gate → delete the `hasExplicitProviderModelChoice` early return. Expected: "preserves a curated profile under a seed policy" FAILS.

If any mutation leaves the suite green, that test asserts nothing — fix the test before continuing.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm dlx ultracite fix && pnpm --filter @brainstrike/app-state typecheck
```

Typecheck reports errors in the three old hooks (they still pass `readonly string[]`). That is expected and is resolved in Task 3 — do not "fix" them by widening the parameter type.

```bash
git add packages/app-state/src/stores/model-registry-store.ts packages/app-state/src/__tests__/model-registry-store.test.ts
git commit -m "fix(BST-1794): enable catalog defaults per row, not per provider

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: One hook over the policy map

**Files:**
- Modify: `packages/app-shell/src/hooks/use-provider-model-defaults.ts` (full rewrite)
- Create: `packages/app-shell/src/hooks/use-provider-model-defaults.test.tsx`

**Interfaces:**
- Consumes: `PROVIDER_MODEL_DEFAULT_POLICIES` (Task 1), the policy-taking action (Task 2).
- Produces: `useProviderModelDefaults(configuredProviders, db, secretsVersion, providerDiscoveryEnabled, providerReadErrors)` — **same five-parameter signature as today**, so `assistant-ui-panel-wrapper.tsx:227` needs no edit.

- [ ] **Step 1: Write the failing test**

Create `packages/app-shell/src/hooks/use-provider-model-defaults.test.tsx`. Model the mock setup on the existing `use-openai-codex-model-defaults.test.tsx` in the same directory — read it first and match its `vi.mock` of `@brainstrike/app-state/stores/model-registry-store` and `@brainstrike/ui`.

```tsx
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderModelDefaults } from './use-provider-model-defaults';

const initializeProviderModelDefaults = vi.fn(async () => 'initialized' as const);
const toast = vi.fn();

vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: (selector: (state: unknown) => unknown) =>
    selector({ error: null, hasLoaded: true, initializeProviderModelDefaults }),
}));
vi.mock('@brainstrike/ui', () => ({ useToast: () => ({ toast }) }));

const db = { query: vi.fn() } as never;

describe('useProviderModelDefaults', () => {
  beforeEach(() => {
    initializeProviderModelDefaults.mockClear();
    toast.mockClear();
  });

  it('dispatches an availability policy for each first-party keyed provider', () => {
    renderHook(() => useProviderModelDefaults(['anthropic', 'google', 'openai'], db, 1, true));

    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(3);
    for (const provider of ['anthropic', 'google', 'openai']) {
      expect(initializeProviderModelDefaults).toHaveBeenCalledWith(db, provider, { kind: 'all' });
    }
  });

  it('dispatches the seed policy for openrouter', () => {
    renderHook(() => useProviderModelDefaults(['openrouter'], db, 1, true));

    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);
    expect(initializeProviderModelDefaults).toHaveBeenCalledWith(
      db,
      'openrouter',
      expect.objectContaining({ kind: 'seed' })
    );
  });

  it('dispatches nothing for a provider with no catalog defaults', () => {
    renderHook(() => useProviderModelDefaults(['ollama', 'voyage'], db, 1, true));

    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('dispatches nothing for a provider that is not configured', () => {
    renderHook(() => useProviderModelDefaults([], db, 1, true));

    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('dispatches once per db and secrets revision', () => {
    const { rerender } = renderHook(
      ({ version }: { version: number }) =>
        useProviderModelDefaults(['anthropic'], db, version, true),
      { initialProps: { version: 1 } }
    );
    rerender({ version: 1 });
    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);

    rerender({ version: 2 });
    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(2);
  });

  it('suppresses only the provider that reported a read error', () => {
    renderHook(() =>
      useProviderModelDefaults(['anthropic', 'openai'], db, 1, true, {
        anthropic: 'key unreadable',
      })
    );

    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);
    expect(initializeProviderModelDefaults).toHaveBeenCalledWith(db, 'openai', { kind: 'all' });
  });

  it('raises a destructive toast naming the provider that failed', async () => {
    initializeProviderModelDefaults.mockRejectedValueOnce(new Error('db is closed'));

    renderHook(() => useProviderModelDefaults(['anthropic'], db, 1, true));
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());

    expect(toast).toHaveBeenCalledWith({
      description: 'db is closed',
      title: 'Anthropic model setup failed',
      variant: 'destructive',
    });
  });

  it('dispatches nothing while provider discovery is disabled', () => {
    renderHook(() => useProviderModelDefaults(['anthropic'], db, 1, false));

    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @brainstrike/desktop vitest run use-provider-model-defaults
```

If that filter reports no such project, the app-shell package's own runner is
`pnpm --filter @brainstrike/app-shell vitest run use-provider-model-defaults` —
use whichever resolves; do not add a new Vitest project.

Expected: FAIL — the current hook calls three per-provider hooks and never reaches the policy map.

- [ ] **Step 3: Rewrite the hook**

Replace the whole contents of `packages/app-shell/src/hooks/use-provider-model-defaults.ts`:

```ts
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  getProviderDisplayName,
  PROVIDER_MODEL_DEFAULT_POLICIES,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useEffect, useRef } from 'react';

const logger = createLogger('ProviderModelDefaults');

interface InitializationAttempt {
  readonly db: DbHandle;
  readonly secretsVersion: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * First-configuration and ongoing catalog enablement for every provider that
 * declares a policy (BST-1794). This replaced three near-identical
 * per-provider hooks: the asymmetry between them was the bug, because
 * `openai`, `anthropic` and `google` simply never got one and their newest
 * catalog rows stayed unreachable.
 *
 * Driving it from `PROVIDER_MODEL_DEFAULT_POLICIES` means a new provider
 * cannot be added without stating a policy — the map is exhaustive over
 * `SupportedProvider` and will not compile otherwise.
 *
 * The attempt guard is per provider AND per `{db, secretsVersion}`: one
 * dispatch per app session, and again when credentials change. That cadence is
 * what makes an `all` policy standing rather than one-time — a model added by a
 * later migration is evaluated on the next launch.
 */
export function useProviderModelDefaults(
  configuredProviders: readonly SupportedProvider[],
  db: DbHandle | null,
  secretsVersion: number,
  providerDiscoveryEnabled = true,
  providerReadErrors?: Partial<Record<SupportedProvider, string>>
): void {
  const hasLoaded = useModelRegistryStore((state) => state.hasLoaded);
  const registryError = useModelRegistryStore((state) => state.error);
  const initializeProviderModelDefaults = useModelRegistryStore(
    (state) => state.initializeProviderModelDefaults
  );
  const attempted = useRef<Map<SupportedProvider, InitializationAttempt>>(new Map());
  const { toast } = useToast();

  useEffect(() => {
    if (!(providerDiscoveryEnabled && db && hasLoaded) || registryError) {
      return;
    }

    for (const provider of configuredProviders) {
      const policy = PROVIDER_MODEL_DEFAULT_POLICIES[provider];
      if (!policy || providerReadErrors?.[provider]) {
        continue;
      }

      const previous = attempted.current.get(provider);
      if (previous?.db === db && previous.secretsVersion === secretsVersion) {
        continue;
      }
      attempted.current.set(provider, { db, secretsVersion });

      void initializeProviderModelDefaults(db, provider, policy).catch((error: unknown) => {
        const description = errorMessage(error);
        logger.error('Failed to initialize provider model defaults', { error, provider });
        toast({
          description,
          title: `${getProviderDisplayName(provider)} model setup failed`,
          variant: 'destructive',
        });
      });
    }
  }, [
    configuredProviders,
    db,
    hasLoaded,
    initializeProviderModelDefaults,
    providerDiscoveryEnabled,
    providerReadErrors,
    registryError,
    secretsVersion,
    toast,
  ]);
}
```

Note `providerReadErrors` is now a whole-object dependency rather than a
per-slot one. That is correct here — the effect reads every provider's slot, so
depending on one slot would be the exact staleness bug the old Codex hook's
comment warns about.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @brainstrike/app-shell vitest run use-provider-model-defaults
```

Expected: PASS, 8 tests.

If the toast title assertion fails, read the actual `displayName` for
`anthropic` from `provider-catalog.json` and correct the **test** to that
verbatim string — do not hardcode a title in the hook.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix && pnpm --filter @brainstrike/app-shell typecheck
```

```bash
git add packages/app-shell/src/hooks/use-provider-model-defaults.ts packages/app-shell/src/hooks/use-provider-model-defaults.test.tsx
git commit -m "feat(BST-1794): drive catalog defaults from one exhaustive policy map

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Remove the superseded hooks and record the contract

**Files:**
- Delete: `packages/app-shell/src/hooks/use-openrouter-model-defaults.ts`, `use-bedrock-model-defaults.ts`, `use-openai-codex-model-defaults.ts` and their three co-located `.test.tsx` files
- Modify: `docs/agents/assistant-providers.md`

**Interfaces:**
- Consumes: Task 3's hook is the only remaining caller of the action.
- Produces: nothing new.

- [ ] **Step 1: Confirm nothing still imports the three hooks**

```bash
grep -rn "use-openrouter-model-defaults\|use-bedrock-model-defaults\|use-openai-codex-model-defaults\|useOpenRouterDefaults\|useBedrockDefaults\|useOpenAiCodexDefaults" packages apps --include="*.ts" --include="*.tsx" | grep -v dist
```

Expected: only the six files being deleted. Any other hit must be resolved before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm packages/app-shell/src/hooks/use-openrouter-model-defaults.ts \
       packages/app-shell/src/hooks/use-openrouter-model-defaults.test.tsx \
       packages/app-shell/src/hooks/use-bedrock-model-defaults.ts \
       packages/app-shell/src/hooks/use-bedrock-model-defaults.test.tsx \
       packages/app-shell/src/hooks/use-openai-codex-model-defaults.ts \
       packages/app-shell/src/hooks/use-openai-codex-model-defaults.test.tsx
```

`BEDROCK_RECOMMENDED_MODEL_IDS`, `OPENAI_CODEX_RECOMMENDED_MODEL_IDS` and
`OPENROUTER_RECOMMENDED_CODING_MODEL_IDS` and their assistant-contract tests all
**stay** — the policy map consumes them.

- [ ] **Step 3: Record the contract**

In `docs/agents/assistant-providers.md`, add this subsection directly after
`#### Read the BASE rate, not the rate in force right now` and before
`### Provider registry auth metadata`:

```markdown
#### `is_enabled` is not evidence of user intent

- Catalog rows ship `is_enabled = false` and migrations preserve the toggle with
  `is_enabled = models.is_enabled`. Enablement without the user comes only from
  `initializeProviderModelDefaults`, driven by `PROVIDER_MODEL_DEFAULT_POLICIES`.
- That map is exhaustive over `SupportedProvider`: `{ kind: 'all' }` (every LLM
  row is on unless the user said otherwise), `{ kind: 'seed', modelIds }` (a
  curated set applied once while the provider is untouched), or `null` (no
  catalog defaults — keyless, or no LLM rows). `null` holds exactly when
  `authType === 'none' || !capabilities.llm`, pinned by test, not by a list.
- "The user touched this row" is `updated_at > created_at` PER ROW. A shipped
  enabled row is NOT a user choice — reading `is_enabled` as intent is what made
  seven catalog models permanently unreachable (BST-1794).
- The `untouched` predicate requires `!is_enabled` as well, so no default policy
  can ever switch a model off.

Evidence: `assistant-providers/model-enablement-defaults.md`.
Guard: `packages/assistant-contract/src/__tests__/provider-model-default-policies.test.ts`,
`packages/app-state/src/__tests__/model-registry-store.test.ts`,
`packages/app-shell/src/hooks/use-provider-model-defaults.test.tsx`.
```

Then create the evidence file `docs/agents/assistant-providers/model-enablement-defaults.md`, following the format of a sibling file in that directory (read one first — the contract holds rules, the evidence file holds their history). It records: the seven dark models with their migration numbers, the `Boolean(row.is_enabled)` predicate that caused it, why adding a per-provider hook would have been a no-op, and the `all`/`seed` split with the OpenRouter opt-in consequence.

- [ ] **Step 4: Run the full affected suites**

```bash
pnpm --filter @brainstrike/assistant-contract --filter @brainstrike/app-state --filter @brainstrike/app-shell test
```

Expected: PASS. A failure in `provider-registry-auth.test.ts` or another
contract test means the docs edit broke a pinned sentence — read the assertion
and fix the doc, not the test.

- [ ] **Step 5: Lint and commit**

```bash
pnpm dlx ultracite check && pnpm run react-doctor
```

```bash
git add -A packages/app-shell/src/hooks docs/agents/assistant-providers.md docs/agents/assistant-providers
git commit -m "refactor(BST-1794): retire the three per-provider defaults hooks

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Verify against the running app

**Files:** none — this is the CDT verification gate. Source is not evidence; a passing unit suite does not show a model in the menu.

- [ ] **Step 1: Launch the desktop app**

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```

- [ ] **Step 2: Confirm the seven models are now selectable**

Open the composer model menu → **More models** → **Hosted** → **Anthropic**.
Expected: `Claude Opus 5` and `Claude Fable 5.1` are present and selectable.
Check **OpenAI** for `GPT-6 Astra` and **Google** for the three 3.x Flash rows
and `Gemini 3.5 Flash-Lite`. Capture a screenshot of the Anthropic submenu.

- [ ] **Step 3: Confirm a user's "off" is still honoured**

In Settings → Models, disable one newly-enabled model (e.g. `Claude Fable 5.1`).
Fully quit the app (SIGTERM — **never** `kill -9`, it corrupts the PGlite store)
and relaunch. Expected: it is still disabled. This is the invariant the whole
design rests on; if it comes back enabled, `updated_at` is not being written
where the design assumes and Task 2 must be revisited.

- [ ] **Step 4: Confirm OpenRouter was not re-seeded**

With an OpenRouter key configured and a curated set, relaunch. Expected: the
enabled OpenRouter set is unchanged — no recommended route switched itself on.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin seandearnaley/bst-1794-a-newly-added-catalog-model-can-never-reach-an-existing
```

PR title: `fix(BST-1794): make a catalog addition reachable on an existing profile`.
The description must contain `BST-1794`, the seven-model table, the `all`/`seed`
split, the OpenRouter opt-in consequence, and the Task 5 screenshots. End it with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

**Spec coverage.** §2.1 policy split → Task 1. §2.2 store action, `untouched`, `capabilities` in the query, dropped `missingModelIds` for `all` → Task 2. §2.3 single hook + exhaustive map → Tasks 1 and 3. §3 testing, including the RED test and the mutation requirement → Tasks 1, 2, 3. §4 file table → all tasks; the `assistant-providers.md` row → Task 4. §5 known consequence → no task; it is BST-1795.

**Placeholders.** None. Two steps are deliberately conditional rather than vague: Task 3 Step 2's runner filter (the app-shell test project name is verified at run time, not guessed) and Task 4 Step 3's evidence file (the sibling-file format is read rather than invented — writing a format from memory is how these drift).

**Type consistency.** `ProviderModelDefaultPolicy` is defined once in Task 1 and consumed with the same shape in Tasks 2 and 3. `PROVIDER_MODEL_DEFAULT_POLICIES` is indexed identically in the hook and the tests. The action's third parameter is `policy` in the interface, the implementation and every call site. `isUntouchedChoiceRow` / `isLlmChoiceRow` are named identically in the implementation and in the mutation steps that target them.

**One gap found and closed.** The spec's `Record<CatalogDefaultProvider, …>` cannot be written — TypeScript derives no union from a runtime filter. The spec was amended to `Record<SupportedProvider, ProviderModelDefaultPolicy | null>` with the derivation pinned as a test, and this plan implements that.
