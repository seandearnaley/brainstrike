# BST-1795 Searchable Composer Model Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the composer's three-deep model dropdown with a search-first picker whose search also finds disabled registry-backed models and enables one on pick.

**Architecture:** Selection logic is a pure function in `packages/assistant-ui` (`buildComposerPickerSections`) built on a pure word matcher shared with `packages/ui` (`matchesModelQuery`). A thin Popover + `cmdk` component (`ComposerModelPicker`) renders it and replaces `ComposerModelMenu`. Enablement goes through Settings' existing `useModelToggle`, which now returns `Promise<boolean>`. The picker selects a model only after the write commits.

**Tech Stack:** TypeScript strict, React 19, Radix Popover (`@brainstrike/ui`), `cmdk` ^1.1.1, Zustand, Vitest (happy-dom and browser lanes), Playwright.

Spec: `docs/superpowers/specs/2026-09-22-composer-model-picker-search-design.md`
Worktree: `/Users/seandearnaley/Documents/GitHub/brainstrike-bst-1795`
Branch: `seandearnaley/bst-1795-composer-model-menu-has-no-search-the-picker-that-does-is`

## Global Constraints

- Every commit message and the PR description carry `BST-1795`.
- TypeScript strict. **Never `any`**; use `unknown` and narrowing. Annotate parameters and return types.
- Filenames kebab-case. Components export PascalCase. Hooks are `use-*.ts`.
- Selection is the composite key `provider::model` end to end. A bare model id never selects anything.
- `assistant-ui` stays presentational: it depends on `@brainstrike/ui` (plus `cmdk`, added in Task 4) and calls back into its host. It never imports app-state, settings-ui or db.
- No failure is silent. A failed enable shows a destructive toast (from the host) and leaves the selection unchanged.
- Stacking comes from the shared `PopoverContent` (`POPUP_LAYER_CLASS`). Never hardcode a `z-` utility. No transform, zoom or scale on the trigger or any wrapper around it (`docs/agents/ui-conventions.md`).
- The trigger keeps `data-testid="composer-model-menu-trigger"` and the accessible name `Selected model: <label>`.
- Biome/Ultracite: object keys sorted, block statements, `noExcessiveLinesPerFile` at 1000.
- Commit normally with `git commit`. Hooks are healthy and MUST run; never pass `--no-verify` or `-c core.hooksPath=...`. Run from the worktree above. The shared hooks live in the main checkout's `.git/hooks`; don't reinstall them.
- Test commands: `pnpm --filter <pkg> exec vitest run <name>`. The type-check script is named `type-check`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/ui/src/model-picker/utils/match-model-query.ts` | **New.** The pure word matcher `matchesModelQuery` |
| `packages/ui/src/model-picker/utils/filter-models.ts` | Rewritten on top of `matchesModelQuery` |
| `packages/ui/src/model-picker/index.ts` | Also exports `matchesModelQuery`, `ModelQueryFields`, `ModelPickerSearch` |
| `packages/settings-ui/src/settings/models/use-model-toggle.ts` | `toggle` returns `Promise<boolean>` |
| `packages/settings-ui/package.json` | Adds the `./settings/models/use-model-toggle` subpath export |
| `packages/assistant-ui/src/composer-picker-sections.ts` | **New.** Pure: provider groups + recents + query → sections. Also the composite-key helpers |
| `packages/assistant-ui/src/composer-model-picker.tsx` | **New.** Popover + `cmdk` rendering of the sections |
| `packages/assistant-ui/src/composer-model-menu.tsx` | **Deleted** |
| `packages/assistant-ui/src/assistant-ui-panel.tsx` | `onModelToggle` replaced by `onEnableModel`, passed down alongside `onModelChange` |
| `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` | `handleModelToggle` replaced by `handleEnableModel`, built on `useModelToggle` |
| `apps/web/e2e/assistant-panel.test.ts`, `apps/web/e2e/assistant-ui-panel.test.ts`, `apps/desktop/e2e/delegated-child-control.desktop.test.ts`, `apps/desktop/e2e/secrets-settings.test.ts` | Pick models by search, not through the "More models" submenus |

Task order is dependency order. Each task leaves the tree green.

---

### Task 1: Shared word matcher in `@brainstrike/ui`

**Files:**
- Create: `packages/ui/src/model-picker/utils/match-model-query.ts`
- Create: `packages/ui/src/model-picker/__tests__/match-model-query.test.ts`
- Modify: `packages/ui/src/model-picker/utils/filter-models.ts`
- Modify: `packages/ui/src/model-picker/index.ts`

**Interfaces — Produces:**
- `interface ModelQueryFields { label: string; modelId: string; providerId: string; providerName?: string | null; tagline?: string | null }`
- `function matchesModelQuery(fields: ModelQueryFields, query: string): boolean`
- `ModelPickerSearch` exported from `@brainstrike/ui`, with its existing props (`value`, `onValueChange`, `placeholder`, `className`).

- [ ] **Step 1: Write the failing test**

Before writing it, check where `packages/ui/src/model-picker` keeps its tests, and put the file there if that differs from the path below.

```ts
import { describe, expect, it } from 'vitest';
import { matchesModelQuery, type ModelQueryFields } from '../utils/match-model-query';

const opus: ModelQueryFields = {
  label: 'Claude Opus 5',
  modelId: 'claude-opus-5',
  providerId: 'bedrock',
  providerName: 'Amazon Bedrock',
  tagline: 'For complex agentic coding',
};

describe('matchesModelQuery', () => {
  it.each([
    ['', true],
    ['   ', true],
    ['opus', true],
    ['OPUS', true],
    ['claude-opus-5', true],
    ['bedrock', true],
    ['amazon', true],
    ['agentic', true],
    ['opus bedrock', true],
    ['opus  amazon   coding', true],
    ['opus anthropic', false],
    ['sonnet', false],
  ])('query %j → %s', (query, expected) => {
    expect(matchesModelQuery(opus, query)).toBe(expected);
  });

  it('never matches a word across two fields', () => {
    // "5bedrock" would only match if the label and the provider id were glued together.
    expect(matchesModelQuery(opus, '5bedrock')).toBe(false);
  });

  it('treats missing optional fields as empty', () => {
    const bare: ModelQueryFields = { label: 'Kimi K3', modelId: 'moonshotai/kimi-k3', providerId: 'openrouter' };
    expect(matchesModelQuery(bare, 'moonshotai')).toBe(true);
    expect(matchesModelQuery(bare, 'agentic')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @brainstrike/ui exec vitest run match-model-query`
Expected: FAIL, `Failed to resolve import "../utils/match-model-query"`.

- [ ] **Step 3: Implement**

`packages/ui/src/model-picker/utils/match-model-query.ts`:

```ts
/** The text a model can be found by. */
export interface ModelQueryFields {
  label: string;
  modelId: string;
  providerId: string;
  providerName?: string | null;
  tagline?: string | null;
}

// Newline separates fields so a query word (which never contains whitespace)
// cannot match across two of them.
const FIELD_SEPARATOR = '\n';

/**
 * Case-insensitive, whitespace-tokenised AND: every word must appear in one of
 * the fields. An empty or whitespace-only query matches everything. No fuzzy
 * matching — the same rule the command palette documents.
 */
export function matchesModelQuery(fields: ModelQueryFields, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return true;
  }
  const haystack = [
    fields.label,
    fields.modelId,
    fields.providerId,
    fields.providerName ?? '',
    fields.tagline ?? '',
  ]
    .join(FIELD_SEPARATOR)
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
```

Rewrite `packages/ui/src/model-picker/utils/filter-models.ts` so its search half calls the matcher. Its results can only widen, never narrow:

```ts
import type { ModelPickerModel, ModelType } from '../types';
import { matchesModelQuery } from './match-model-query';

export function filterModels(
  models: ModelPickerModel[],
  searchQuery: string,
  typeFilter: ModelType = 'all'
): ModelPickerModel[] {
  return models.filter(
    (model) =>
      (typeFilter === 'all' || model.capabilities.type === typeFilter) &&
      matchesModelQuery(
        {
          label: model.name,
          modelId: model.modelId ?? model.id,
          providerId: model.providerId,
          tagline: model.description,
        },
        searchQuery
      )
  );
}
```

Add to `packages/ui/src/model-picker/index.ts`:

```ts
export { ModelPickerSearch } from './model-picker-search';
export { matchesModelQuery, type ModelQueryFields } from './utils/match-model-query';
```

- [ ] **Step 4: Run the new tests and every existing model-picker test**

Run: `pnpm --filter @brainstrike/ui exec vitest run match-model-query filter-models model-picker`
Expected: PASS. Every existing `filterModels` test must pass **unchanged**. If one fails, the old behaviour was narrower in a way the spec didn't anticipate: stop and report it rather than editing the test.

- [ ] **Step 5: Mutate**

Replace `words.every` with `words.some`. The `'opus anthropic'` row must fail. Revert.

- [ ] **Step 6: Type-check and commit**

```bash
pnpm --filter @brainstrike/ui run type-check
git add packages/ui/src/model-picker
git commit -m "feat(BST-1795): share a word matcher across model pickers"
```

---

### Task 2: `useModelToggle` reports whether the write committed

**Files:**
- Modify: `packages/settings-ui/src/settings/models/use-model-toggle.ts`
- Modify: `packages/settings-ui/package.json` (`exports`)
- Create: `packages/settings-ui/src/settings/models/__tests__/use-model-toggle.test.tsx`

**Interfaces — Produces:**
- `ModelToggleController.toggle: (modelId: string, enabled: boolean) => Promise<boolean>`: `true` once the write commits, `false` after a destructive toast (the database isn't ready, or the write was rejected).
- Import path: `@brainstrike/settings-ui/settings/models/use-model-toggle`.

- [ ] **Step 1: Write the failing test**

Mock the three hooks the way sibling settings-ui tests do. Read `packages/settings-ui/src/settings/providers/__tests__/providers-settings.test.tsx` first and copy its mocking style.

```tsx
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
const toggleModel = vi.fn<(db: unknown, modelId: string, enabled: boolean) => Promise<void>>();
let db: unknown = { query: vi.fn() };

vi.mock('@brainstrike/ui', () => ({ useToast: () => ({ toast }) }));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => db }));
vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: (selector: (state: { toggleModel: typeof toggleModel }) => unknown) =>
    selector({ toggleModel }),
}));

import { useModelToggle } from '../use-model-toggle';

describe('useModelToggle', () => {
  beforeEach(() => {
    toast.mockClear();
    toggleModel.mockReset();
    db = { query: vi.fn() };
  });

  it('resolves true once the write commits', async () => {
    toggleModel.mockResolvedValue(undefined);
    const { result } = renderHook(() => useModelToggle());
    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.toggle('claude-opus-5', true);
    });
    expect(committed).toBe(true);
    expect(toggleModel).toHaveBeenCalledWith(db, 'claude-opus-5', true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('resolves false and toasts when the write is rejected', async () => {
    toggleModel.mockRejectedValue(new Error('disk full'));
    const { result } = renderHook(() => useModelToggle());
    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.toggle('claude-opus-5', true);
    });
    expect(committed).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'disk full', variant: 'destructive' })
    );
  });

  it('resolves false and toasts without writing when the database is not ready', async () => {
    db = null;
    const { result } = renderHook(() => useModelToggle());
    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.toggle('claude-opus-5', true);
    });
    expect(committed).toBe(false);
    expect(toggleModel).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('releases the busy flag after either outcome', async () => {
    toggleModel.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useModelToggle());
    await act(async () => {
      await result.current.toggle('m', true);
    });
    expect(result.current.busyModelIds.has('m')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run use-model-toggle`
Expected: FAIL. `committed` is `undefined`, because `toggle` returns `void` today.

- [ ] **Step 3: Implement**

Replace the interface member and the `toggle` callback. Keep the existing file doc comment, `release`, and the toast copy exactly as they are:

```ts
export interface ModelToggleController {
  /** Model ids with a write in flight; their switches disable. */
  readonly busyModelIds: ReadonlySet<string>;
  /**
   * Resolves `true` once the write commits and `false` after a destructive
   * toast. It never rejects, so a caller can act on success without a second
   * error path.
   */
  readonly toggle: (modelId: string, enabled: boolean) => Promise<boolean>;
}
```

```ts
  const toggle = useCallback(
    async (modelId: string, enabled: boolean): Promise<boolean> => {
      if (!db) {
        toast({
          description: 'The model database is not ready yet. Try again in a moment.',
          title: 'Could not update model',
          variant: 'destructive',
        });
        return false;
      }
      setBusyModelIds((current) => new Set(current).add(modelId));
      try {
        await toggleModel(db, modelId, enabled);
        return true;
      } catch (error: unknown) {
        toast({
          description: error instanceof Error ? error.message : 'The change was not saved.',
          title: `Could not ${enabled ? 'enable' : 'disable'} this model`,
          variant: 'destructive',
        });
        return false;
      } finally {
        release(modelId);
      }
    },
    [db, release, toast, toggleModel]
  );
```

Check the two existing callers: `settings/providers/providers-settings.tsx:86` and `settings/models/model-selection-page.tsx:279`. They ignore the return value and must still type-check. If Biome flags a floating promise in a handler, prefix the call with `void`. Don't change their behaviour.

Add the subpath export to `packages/settings-ui/package.json`, in the same shape as the existing entries and in alphabetical position:

```json
"./settings/models/use-model-toggle": {
  "types": "./dist/settings/models/use-model-toggle.d.ts",
  "import": "./dist/settings/models/use-model-toggle.js"
},
```

- [ ] **Step 4: Run and verify**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run use-model-toggle providers-settings model-selection`
Expected: PASS.
Run: `pnpm --filter @brainstrike/settings-ui run type-check`, then `pnpm --filter @brainstrike/settings-ui run build`. The build must emit `dist/settings/models/use-model-toggle.js` and its `.d.ts`.

- [ ] **Step 5: Mutate**

Make the `catch` branch `return true`. The rejected-write test must fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add packages/settings-ui
git commit -m "feat(BST-1795): useModelToggle resolves whether the write committed"
```

---

### Task 3: Pure picker sections in `assistant-ui`

**Files:**
- Create: `packages/assistant-ui/src/composer-picker-sections.ts`
- Create: `packages/assistant-ui/src/__tests__/composer-picker-sections.test.ts`

**Interfaces:**
- Consumes: `matchesModelQuery` from `@brainstrike/ui` (Task 1). Also `ProviderGroupConfig` and `ProviderRuntimeCategory` from `./assistant-ui-panel` (type-only imports).
- Produces:
  - `composerModelCompositeKey(providerId: string, modelId: string): string`
  - `modelIdFromCompositeKey(compositeKey: string | undefined): string | undefined`: moved verbatim from `composer-model-menu.tsx`
  - `interface ComposerPickerEntry { compositeKey: string; isDefault: boolean; isEnabled: boolean; meta: ModelPickerModel | undefined; modelId: string; modelLabel: string; providerId: string; providerName: string; runtime: ProviderRuntimeCategory; runtimeLabel: string }`
  - `interface ComposerPickerProviderGroup { providerId: string; providerName: string; runtime: ProviderRuntimeCategory; runtimeLabel: string; entries: ComposerPickerEntry[] }`
  - `interface ComposerPickerSections { enabledByKey: ReadonlyMap<string, ComposerPickerEntry>; groups: ComposerPickerProviderGroup[]; matches: ComposerPickerEntry[]; notEnabled: ComposerPickerEntry[]; recent: ComposerPickerEntry[] }`
  - `function buildComposerPickerSections(args: { pickerModels: readonly ModelPickerModel[]; providerGroups: readonly ProviderGroupConfig[]; query: string; recentModels: readonly string[]; selectedModel: string | undefined }): ComposerPickerSections`

- [ ] **Step 1: Write the failing test**

Reuse the exact `providerGroups` / `pickerModels` fixture from `packages/assistant-ui/src/__tests__/composer-model-menu.test.tsx`. Copy it in; don't import it, because that file is deleted in Task 4. Then extend the copy:
- add a disabled model to `openrouter`: `{ enabled: false, id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', type: 'llm' }`;
- add a `Local` group with one `ollama` provider (`runtime: 'local'`) holding a disabled model `{ enabled: false, id: 'llama4:8b', label: 'Llama 4 8B', type: 'llm' }`;
- add an `openai-codex` provider (`runtime: 'hosted'`, name `'OpenAI (ChatGPT)'`) with an enabled model `{ enabled: true, id: 'codex/gpt-5.5', label: 'GPT-5.5', type: 'llm' }`, and an `openai` model `{ enabled: true, id: 'gpt-5.5', label: 'GPT-5.5', type: 'llm' }`. That gives the colliding labels.

```ts
import { describe, expect, it } from 'vitest';
import {
  buildComposerPickerSections,
  composerModelCompositeKey,
  modelIdFromCompositeKey,
} from '../composer-picker-sections';
// ...fixture: providerGroups, pickerModels (as described above)...

const base = {
  pickerModels,
  providerGroups,
  query: '',
  recentModels: [] as string[],
  selectedModel: 'openai::gpt-5.6-terra',
};
const keys = (entries: readonly { compositeKey: string }[]): string[] =>
  entries.map((entry) => entry.compositeKey);

describe('composite keys', () => {
  it('round-trips', () => {
    expect(composerModelCompositeKey('openrouter', 'moonshotai/kimi-k3')).toBe('openrouter::moonshotai/kimi-k3');
    expect(modelIdFromCompositeKey('openrouter::moonshotai/kimi-k3')).toBe('moonshotai/kimi-k3');
    expect(modelIdFromCompositeKey(undefined)).toBeUndefined();
  });
});

describe('buildComposerPickerSections — empty query', () => {
  it('puts the selection first, then valid recents, deduped, capped at 5', () => {
    const sections = buildComposerPickerSections({
      ...base,
      recentModels: ['openai::gpt-5.6-terra', 'anthropic::claude-sonnet-5', 'google::not-real', 'openrouter::moonshotai/kimi-k3'],
    });
    expect(keys(sections.recent)).toEqual([
      'openai::gpt-5.6-terra',
      'anthropic::claude-sonnet-5',
      'openrouter::moonshotai/kimi-k3',
    ]);
  });

  it('falls back to default-flagged models when there is no selection or recent', () => {
    const sections = buildComposerPickerSections({ ...base, selectedModel: undefined });
    expect(keys(sections.recent)).toEqual(['openai::gpt-5.6-terra', 'anthropic::claude-sonnet-5']);
  });

  it('groups enabled models by provider in catalog order and hides disabled ones', () => {
    const sections = buildComposerPickerSections(base);
    const all = sections.groups.flatMap((group) => keys(group.entries));
    expect(all).not.toContain('openrouter::deepseek/deepseek-v4.1-flash');
    expect(all).not.toContain('ollama::llama4:8b');
    expect(sections.groups[0]).toMatchObject({ providerId: 'openai', runtimeLabel: 'Hosted' });
    expect(sections.matches).toEqual([]);
    expect(sections.notEnabled).toEqual([]);
  });

  it('keeps colliding labels apart by composite key and provider name', () => {
    const sections = buildComposerPickerSections(base);
    const gpt55 = sections.groups.flatMap((group) => group.entries).filter((entry) => entry.modelLabel === 'GPT-5.5');
    expect(gpt55.map((entry) => [entry.compositeKey, entry.providerName])).toEqual([
      ['openai::gpt-5.5', 'OpenAI'],
      ['openai-codex::codex/gpt-5.5', 'OpenAI (ChatGPT)'],
    ]);
  });
});

describe('buildComposerPickerSections — with a query', () => {
  it('flattens enabled matches in catalog order and clears recent/groups', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'gpt' });
    expect(sections.recent).toEqual([]);
    expect(sections.groups).toEqual([]);
    expect(keys(sections.matches)).toEqual(['openai::gpt-5.6-terra', 'openai::gpt-5.5', 'openai-codex::codex/gpt-5.5']);
  });

  it('surfaces disabled registry-backed matches under notEnabled', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'deepseek' });
    expect(sections.matches).toEqual([]);
    expect(keys(sections.notEnabled)).toEqual(['openrouter::deepseek/deepseek-v4.1-flash']);
  });

  it('never offers local-runtime or browser providers under notEnabled', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'llama' });
    expect(sections.notEnabled).toEqual([]);
  });

  it('matches the provider display name', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'chatgpt' });
    expect(keys(sections.matches)).toEqual(['openai-codex::codex/gpt-5.5']);
  });

  it('returns every section empty when nothing matches', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'zzzz' });
    expect([sections.recent, sections.groups, sections.matches, sections.notEnabled]).toEqual([[], [], [], []]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @brainstrike/assistant-ui exec vitest run composer-picker-sections`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`packages/assistant-ui/src/composer-picker-sections.ts`:

```ts
/**
 * Pure selection logic for the composer model picker (BST-1795). Selection is
 * COMPOSITE-KEY ("provider::model") end to end — the picker never resolves a
 * bare model id back to a provider.
 */
import { matchesModelQuery, type ModelPickerModel } from '@brainstrike/ui';
import type { ProviderGroupConfig, ProviderRuntimeCategory } from './assistant-ui-panel';

const MAX_RECENT_ROWS = 4;
const MODEL_KEY_DELIMITER = '::';

/**
 * Runtimes whose enablement lives in the model registry. `local` runtimes
 * (Ollama, LM Studio) enable by discovery and `browser` (built-in local) by
 * download, so the picker never offers to enable them.
 */
const REGISTRY_BACKED_RUNTIMES: ReadonlySet<ProviderRuntimeCategory> = new Set<ProviderRuntimeCategory>([
  'hosted',
  'gateway',
]);

export function composerModelCompositeKey(providerId: string, modelId: string): string {
  return `${providerId}${MODEL_KEY_DELIMITER}${modelId}`;
}

/** Bare model id from a "provider::model" composite key (display only). */
export function modelIdFromCompositeKey(compositeKey: string | undefined): string | undefined {
  if (!compositeKey) {
    return;
  }
  const separatorIndex = compositeKey.indexOf(MODEL_KEY_DELIMITER);
  if (separatorIndex <= 0) {
    return compositeKey;
  }
  return compositeKey.slice(separatorIndex + MODEL_KEY_DELIMITER.length);
}

export interface ComposerPickerEntry {
  compositeKey: string;
  /** The registry `default: true` flag (Recent fallback ordering). */
  isDefault: boolean;
  isEnabled: boolean;
  /** Resolved metadata; present for enabled models only. */
  meta: ModelPickerModel | undefined;
  modelId: string;
  modelLabel: string;
  providerId: string;
  providerName: string;
  runtime: ProviderRuntimeCategory;
  runtimeLabel: string;
}

export interface ComposerPickerProviderGroup {
  entries: ComposerPickerEntry[];
  providerId: string;
  providerName: string;
  runtime: ProviderRuntimeCategory;
  runtimeLabel: string;
}

export interface ComposerPickerSections {
  /** Every enabled entry by composite key (trigger label, selection lookup). */
  enabledByKey: ReadonlyMap<string, ComposerPickerEntry>;
  /** Empty query only. */
  groups: ComposerPickerProviderGroup[];
  /** Non-empty query only: enabled matches, flat, catalog order. */
  matches: ComposerPickerEntry[];
  /** Non-empty query only: disabled registry-backed matches. */
  notEnabled: ComposerPickerEntry[];
  /** Empty query only. */
  recent: ComposerPickerEntry[];
}

function collectEntries(
  providerGroups: readonly ProviderGroupConfig[],
  pickerModels: readonly ModelPickerModel[]
): ComposerPickerEntry[] {
  const metaByKey = new Map<string, ModelPickerModel>();
  for (const model of pickerModels) {
    metaByKey.set(composerModelCompositeKey(model.providerId, model.id), model);
  }
  const entries: ComposerPickerEntry[] = [];
  for (const group of providerGroups) {
    for (const provider of group.providers) {
      for (const model of provider.models) {
        if (model.type !== 'llm') {
          continue;
        }
        const compositeKey = composerModelCompositeKey(provider.id, model.id);
        entries.push({
          compositeKey,
          isDefault: Boolean(model.default),
          isEnabled: model.enabled,
          meta: metaByKey.get(compositeKey),
          modelId: model.id,
          modelLabel: model.label,
          providerId: provider.id,
          providerName: provider.name,
          runtime: provider.runtime,
          runtimeLabel: group.label,
        });
      }
    }
  }
  return entries;
}

/**
 * Selected model first, then valid recents (deduped), capped at
 * 1 + MAX_RECENT_ROWS; falls back to default-flagged models so Recent is never
 * empty while enabled models exist. Same rule the old dropdown used.
 */
function collectRecent(
  enabledByKey: ReadonlyMap<string, ComposerPickerEntry>,
  recentModels: readonly string[],
  selectedModel: string | undefined
): ComposerPickerEntry[] {
  const limit = 1 + MAX_RECENT_ROWS;
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (key: string): void => {
    if (keys.length < limit && !seen.has(key) && enabledByKey.has(key)) {
      keys.push(key);
      seen.add(key);
    }
  };
  if (selectedModel) {
    push(selectedModel);
  }
  for (const key of recentModels) {
    push(key);
  }
  if (keys.length === 0) {
    for (const entry of enabledByKey.values()) {
      if (entry.isDefault) {
        push(entry.compositeKey);
      }
    }
  }
  return keys.flatMap((key) => {
    const entry = enabledByKey.get(key);
    return entry ? [entry] : [];
  });
}

function groupByProvider(entries: readonly ComposerPickerEntry[]): ComposerPickerProviderGroup[] {
  const groups: ComposerPickerProviderGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last?.providerId === entry.providerId) {
      last.entries.push(entry);
      continue;
    }
    groups.push({
      entries: [entry],
      providerId: entry.providerId,
      providerName: entry.providerName,
      runtime: entry.runtime,
      runtimeLabel: entry.runtimeLabel,
    });
  }
  return groups;
}

function entryMatches(entry: ComposerPickerEntry, query: string): boolean {
  return matchesModelQuery(
    {
      label: entry.modelLabel,
      modelId: entry.modelId,
      providerId: entry.providerId,
      providerName: entry.providerName,
      tagline: entry.meta?.description ?? null,
    },
    query
  );
}

export function buildComposerPickerSections(args: {
  pickerModels: readonly ModelPickerModel[];
  providerGroups: readonly ProviderGroupConfig[];
  query: string;
  recentModels: readonly string[];
  selectedModel: string | undefined;
}): ComposerPickerSections {
  const entries = collectEntries(args.providerGroups, args.pickerModels);
  const enabled = entries.filter((entry) => entry.isEnabled);
  const enabledByKey = new Map(enabled.map((entry) => [entry.compositeKey, entry] as const));

  if (args.query.trim().length === 0) {
    return {
      enabledByKey,
      groups: groupByProvider(enabled),
      matches: [],
      notEnabled: [],
      recent: collectRecent(enabledByKey, args.recentModels, args.selectedModel),
    };
  }
  return {
    enabledByKey,
    groups: [],
    matches: enabled.filter((entry) => entryMatches(entry, args.query)),
    notEnabled: entries.filter(
      (entry) =>
        !entry.isEnabled && REGISTRY_BACKED_RUNTIMES.has(entry.runtime) && entryMatches(entry, args.query)
    ),
    recent: [],
  };
}
```

`groupByProvider` relies on each provider's entries being contiguous, which `collectEntries` guarantees: it walks groups → providers → models.

- [ ] **Step 4: Run and verify**

Run: `pnpm --filter @brainstrike/assistant-ui exec vitest run composer-picker-sections`
Expected: PASS.

- [ ] **Step 5: Mutate**

(a) Drop the `REGISTRY_BACKED_RUNTIMES.has(...)` condition: the llama test must fail. (b) Drop `!seen.has(key)`: the dedupe test must fail. Revert both.

- [ ] **Step 6: Type-check and commit**

```bash
pnpm --filter @brainstrike/assistant-ui run type-check
git add packages/assistant-ui/src/composer-picker-sections.ts packages/assistant-ui/src/__tests__/composer-picker-sections.test.ts
git commit -m "feat(BST-1795): pure section builder for the composer model picker"
```

---

### Task 4: `ComposerModelPicker` replaces `ComposerModelMenu`

**Files:**
- Create: `packages/assistant-ui/src/composer-model-picker.tsx`
- Create: `packages/assistant-ui/src/__tests__/composer-model-picker.test.tsx` (ports the 9 menu tests)
- Delete: `packages/assistant-ui/src/composer-model-menu.tsx`, `packages/assistant-ui/src/__tests__/composer-model-menu.test.tsx`
- Modify: `packages/assistant-ui/package.json` (add `cmdk`)
- Modify: `packages/assistant-ui/src/assistant-ui-panel.tsx` (the import at `:65` and the render at `:1426`; pass `onEnableModel` through as an **optional** prop here, and leave the wider pass-through to Task 5)

**Interfaces:**
- Consumes: Task 1's `ModelPickerSearch`, and Task 3's `buildComposerPickerSections`, `ComposerPickerEntry`, `modelIdFromCompositeKey`.
- Produces:

```ts
export interface ComposerModelPickerProps {
  disabled?: boolean | undefined;
  /** Enable a registry-backed model. Resolves true once committed; false after the host reported the failure. */
  onEnableModel?: ((providerId: string, modelId: string) => Promise<boolean>) | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
  pickerModels: ModelPickerModel[];
  providerGroups: ProviderGroupConfig[];
  recentModels?: readonly string[] | undefined;
  selectedModel?: string | undefined;
}
export function ComposerModelPicker(props: ComposerModelPickerProps): JSX.Element
```

`modelIdFromCompositeKey` is re-exported from `composer-model-picker.tsx`, so `assistant-ui-panel.tsx`'s existing import only changes its path.

- [ ] **Step 1: Add the dependency**

Add `"cmdk"` to `packages/assistant-ui/package.json` `dependencies`, using exactly the specifier `packages/ui/package.json` uses (`^1.1.1`, or `catalog:` if `ui` has since moved to one). Then run a single serial install from the worktree root: `SKIP_LEFTHOOK_INSTALL=1 pnpm install --frozen-lockfile=false --prefer-offline`. Then `pnpm exec node -v` to let any reinstall race settle. Check that `pnpm-lock.yaml` changed only for this dependency edge.

- [ ] **Step 2: Write the failing tests**

Read `packages/ui/src/model-picker/__tests__/` first to see how `cmdk` is exercised in this repo's happy-dom lane. `cmdk` calls `scrollIntoView`, and the existing tests show the stub, if one is needed.

Port every case from `composer-model-menu.test.tsx` (same fixture), translated to the new UI. The trigger's test id and accessible name are unchanged; rows are `role="option"`. The two "More models" cases become search cases:

```tsx
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('composer-model-menu-trigger'));
  return screen.findByRole('dialog');
}

it('renders the selected model on the trigger', () => { /* unchanged assertions */ });

it('opens with search focused and shows the selected row with tagline, icons and a Selected mark', async () => {
  const user = setup();
  render(<ComposerModelPicker {...baseProps} onModelChange={vi.fn()} />);
  const picker = await openPicker(user);
  expect(within(picker).getByRole('combobox')).toHaveFocus();
  const row = within(picker).getAllByRole('option', { name: /GPT-5\.6 Terra/ })[0];
  expect(within(row).getByText('Most capable for everyday work')).toBeInTheDocument();
  expect(within(row).getByLabelText('Vision')).toBeInTheDocument();
  expect(within(row).getByLabelText('Reasoning')).toBeInTheDocument();
  expect(within(row).getByLabelText('Selected')).toBeInTheDocument();
});

it('lists valid recents after the selected model, in order, deduped', async () => {
  // same recentModels input as the old test; assert the first three option rows
  // inside the group labelled "Recent"
});

it('emits the composite key when a row is picked', async () => { /* anthropic::claude-sonnet-5 */ });

it('keeps effort and thinking out of the picker', async () => { /* unchanged queries, inside the dialog */ });

it('search flattens to provider-labelled matches and a duplicate bare id resolves through its own provider', async () => {
  const user = setup();
  const onModelChange = vi.fn();
  render(<ComposerModelPicker {...baseProps} onModelChange={onModelChange} />);
  const picker = await openPicker(user);
  await user.type(within(picker).getByRole('combobox'), 'shared');
  const anthropicRow = within(picker).getByRole('option', { name: /Shared \(Anthropic\).*Anthropic/ });
  await user.click(anthropicRow);
  expect(onModelChange).toHaveBeenCalledWith('anthropic::shared-model-id');
});

it('shows a context-window badge on list rows', async () => {
  // open, no query; find the "1.1M context" badge and assert its option row reads GPT-5.6 Terra
});

it('enables then selects a Not enabled match only after the host commits', async () => {
  const user = setup();
  const onModelChange = vi.fn();
  const onEnableModel = vi.fn().mockResolvedValue(true);
  render(<ComposerModelPicker {...fixtureWithDisabledDeepseek} onEnableModel={onEnableModel} onModelChange={onModelChange} />);
  const picker = await openPicker(user);
  await user.type(within(picker).getByRole('combobox'), 'deepseek');
  await user.click(within(picker).getByRole('option', { name: /Enable and select DeepSeek V4\.1 Flash/ }));
  expect(onEnableModel).toHaveBeenCalledWith('openrouter', 'deepseek/deepseek-v4.1-flash');
  await waitFor(() => expect(onModelChange).toHaveBeenCalledWith('openrouter::deepseek/deepseek-v4.1-flash'));
});

it('leaves the selection unchanged when the host reports a failed enable', async () => {
  // same as above with mockResolvedValue(false); assert onModelChange NOT called
});

it('hides Not enabled rows when no onEnableModel handler is provided', async () => { /* type 'deepseek'; no option */ });

it('Escape closes the picker and clears the query', async () => {
  // type 'gpt', press {Escape}, dialog gone; reopen, combobox value is ''
});

it('disables the trigger with a placeholder when no models are enabled', () => { /* unchanged */ });
it('disables the trigger when no onModelChange handler is provided', () => { /* unchanged */ });
```

Write each placeholder comment above out in full, following the patterns shown. They're compressed here only to avoid repeating the fixture. `fixtureWithDisabledDeepseek` is `baseProps` with the openrouter provider given the extra disabled model `{ enabled: false, id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', type: 'llm' }`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @brainstrike/assistant-ui exec vitest run composer-model-picker`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 4: Implement `packages/assistant-ui/src/composer-model-picker.tsx`**

```tsx
/**
 * Search-first composer model picker (BST-1795): Popover + cmdk. Opening
 * focuses search; an empty query shows Recent then enabled models grouped
 * by provider; typing flattens to provider-labelled enabled matches plus
 * disabled registry-backed matches under "Not enabled", which are enabled
 * through the host and selected only once that write commits. Reasoning
 * Effort/Thinking controls stay OUT of this picker (BST-948).
 */
import {
  Button,
  cn,
  formatContextWindow,
  getProviderColor,
  type ModelPickerModel,
  ModelPickerSearch,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@brainstrike/ui';
import { Command } from 'cmdk';
import { Brain, Check, ChevronDown, Eye, Plus } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import type { ProviderGroupConfig } from './assistant-ui-panel';
import { buildComposerPickerSections, type ComposerPickerEntry } from './composer-picker-sections';

export { composerModelCompositeKey, modelIdFromCompositeKey } from './composer-picker-sections';

export interface ComposerModelPickerProps {
  disabled?: boolean | undefined;
  onEnableModel?: ((providerId: string, modelId: string) => Promise<boolean>) | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
  pickerModels: ModelPickerModel[];
  providerGroups: ProviderGroupConfig[];
  /** Composite keys, newest first; invalid entries are filtered here. */
  recentModels?: readonly string[] | undefined;
  /** Composite key "provider::model". */
  selectedModel?: string | undefined;
}

const GROUP_HEADING_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide';

const ROW_CLASS =
  'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden aria-selected:bg-accent aria-selected:text-accent-foreground data-[disabled=true]:opacity-50';

function CapabilityIcons({ meta }: { meta: ModelPickerModel | undefined }): ReactNode {
  if (!meta) {
    return null;
  }
  const { reasoning, vision } = meta.capabilities;
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {vision === 'supported' ? (
        <Eye aria-label="Vision" className="size-3.5" role="img">
          <title>Supports image input</title>
        </Eye>
      ) : null}
      {reasoning === 'supported' ? (
        <Brain aria-label="Reasoning" className="size-3.5" role="img">
          <title>Supports reasoning</title>
        </Brain>
      ) : null}
      {reasoning === 'unknown' ? (
        <Brain aria-label="Reasoning unverified" className="size-3.5 opacity-40" role="img">
          <title>Reasoning support unverified</title>
        </Brain>
      ) : null}
    </span>
  );
}

function ProviderDot({ providerId }: { providerId: string }): ReactNode {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: getProviderColor(providerId, 'light') }}
    />
  );
}

function SelectedMark({ selected }: { selected: boolean }): ReactNode {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {selected ? <Check aria-label="Selected" className="size-4" role="img" /> : null}
    </span>
  );
}

interface RowProps {
  entry: ComposerPickerEntry;
  onPick: (entry: ComposerPickerEntry) => void;
  selected: boolean;
  showProvider: boolean;
}

function RecentRow({ entry, onPick, selected }: Omit<RowProps, 'showProvider'>): ReactNode {
  return (
    <Command.Item className={ROW_CLASS} onSelect={() => onPick(entry)} value={`recent:${entry.compositeKey}`}>
      <ProviderDot providerId={entry.providerId} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-5">{entry.modelLabel}</span>
        {entry.meta?.description ? (
          <span className="block truncate text-muted-foreground text-xs leading-4">{entry.meta.description}</span>
        ) : null}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{entry.providerName}</span>
      <CapabilityIcons meta={entry.meta} />
      <SelectedMark selected={selected} />
    </Command.Item>
  );
}

function ListRow({ entry, onPick, selected, showProvider }: RowProps): ReactNode {
  return (
    <Command.Item className={ROW_CLASS} onSelect={() => onPick(entry)} value={entry.compositeKey}>
      {showProvider ? <ProviderDot providerId={entry.providerId} /> : null}
      <span className="min-w-0 flex-1 truncate leading-5">{entry.modelLabel}</span>
      {showProvider ? <span className="shrink-0 text-[10px] text-muted-foreground">{entry.providerName}</span> : null}
      {entry.meta?.contextWindow ? (
        <span className="shrink-0 rounded-md border border-border/50 bg-background/55 px-1 text-[10px] text-muted-foreground">
          {formatContextWindow(entry.meta.contextWindow)}
        </span>
      ) : null}
      <CapabilityIcons meta={entry.meta} />
      <SelectedMark selected={selected} />
    </Command.Item>
  );
}

function NotEnabledRow({
  entry,
  onEnable,
  pending,
}: {
  entry: ComposerPickerEntry;
  onEnable: (entry: ComposerPickerEntry) => void;
  pending: boolean;
}): ReactNode {
  return (
    <Command.Item
      aria-label={`Enable and select ${entry.modelLabel} (${entry.providerName})`}
      className={ROW_CLASS}
      disabled={pending}
      onSelect={() => onEnable(entry)}
      value={`enable:${entry.compositeKey}`}
    >
      <ProviderDot providerId={entry.providerId} />
      <span className="min-w-0 flex-1 truncate leading-5 text-muted-foreground">{entry.modelLabel}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{entry.providerName}</span>
      <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Command.Item>
  );
}

export function ComposerModelPicker({
  disabled,
  onEnableModel,
  onModelChange,
  pickerModels,
  providerGroups,
  recentModels,
  selectedModel,
}: ComposerModelPickerProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const sections = useMemo(
    () =>
      buildComposerPickerSections({
        pickerModels,
        providerGroups,
        query,
        recentModels: recentModels ?? [],
        selectedModel,
      }),
    [pickerModels, providerGroups, query, recentModels, selectedModel]
  );

  const selectedEntry = selectedModel ? sections.enabledByKey.get(selectedModel) : undefined;
  const hasOptions = sections.enabledByKey.size > 0;
  const canSelect = Boolean(onModelChange) && hasOptions && !disabled;
  const triggerText = selectedEntry ? selectedEntry.modelLabel : hasOptions ? 'Select a model...' : 'No models enabled';

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
    }
  }, []);

  const handlePick = useCallback(
    (entry: ComposerPickerEntry) => {
      onModelChange?.(entry.compositeKey);
      handleOpenChange(false);
    },
    [handleOpenChange, onModelChange]
  );

  const handleEnable = useCallback(
    async (entry: ComposerPickerEntry) => {
      if (!onEnableModel || pendingKey) {
        return;
      }
      setPendingKey(entry.compositeKey);
      const committed = await onEnableModel(entry.providerId, entry.modelId);
      setPendingKey(null);
      // A false result was already reported by the host (destructive toast);
      // the selection deliberately stays where it was.
      if (committed) {
        handlePick(entry);
      }
    },
    [handlePick, onEnableModel, pendingKey]
  );

  const isSearching = query.trim().length > 0;
  const notEnabled = onEnableModel ? sections.notEnabled : [];

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Selected model: ${selectedEntry?.modelLabel ?? 'none'}`}
          className="h-8 gap-2 rounded-full border-border/70 bg-background/85 px-3 text-xs"
          data-testid="composer-model-menu-trigger"
          disabled={!canSelect}
          size="sm"
          variant="outline"
        >
          {selectedEntry ? <ProviderDot providerId={selectedEntry.providerId} /> : null}
          <span className="max-w-44 truncate">{triggerText}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Choose a model"
        className="w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-xl p-0"
        role="dialog"
        sideOffset={6}
      >
        <Command className="flex flex-col" label="Models" shouldFilter={false}>
          <ModelPickerSearch onValueChange={setQuery} placeholder="Search models..." value={query} />
          <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto p-1">
            <Command.Empty className="px-2 py-6 text-center text-muted-foreground text-sm">
              No models match “{query.trim()}”.
            </Command.Empty>
            {isSearching ? null : (
              <>
                {sections.recent.length > 0 ? (
                  <Command.Group className={GROUP_HEADING_CLASS} heading="Recent">
                    {sections.recent.map((entry) => (
                      <RecentRow
                        entry={entry}
                        key={entry.compositeKey}
                        onPick={handlePick}
                        selected={entry.compositeKey === selectedModel}
                      />
                    ))}
                  </Command.Group>
                ) : null}
                {sections.groups.map((group) => (
                  <Command.Group
                    className={GROUP_HEADING_CLASS}
                    heading={`${group.runtimeLabel} · ${group.providerName} ${group.entries.length}`}
                    key={group.providerId}
                  >
                    {group.entries.map((entry) => (
                      <ListRow
                        entry={entry}
                        key={entry.compositeKey}
                        onPick={handlePick}
                        selected={entry.compositeKey === selectedModel}
                        showProvider={false}
                      />
                    ))}
                  </Command.Group>
                ))}
              </>
            )}
            {isSearching && sections.matches.length > 0 ? (
              <Command.Group className={GROUP_HEADING_CLASS} heading="Models">
                {sections.matches.map((entry) => (
                  <ListRow
                    entry={entry}
                    key={entry.compositeKey}
                    onPick={handlePick}
                    selected={entry.compositeKey === selectedModel}
                    showProvider
                  />
                ))}
              </Command.Group>
            ) : null}
            {isSearching && notEnabled.length > 0 ? (
              <Command.Group className={GROUP_HEADING_CLASS} heading="Not enabled">
                {notEnabled.map((entry) => (
                  <NotEnabledRow
                    entry={entry}
                    key={entry.compositeKey}
                    onEnable={(target) => {
                      void handleEnable(target);
                    }}
                    pending={pendingKey === entry.compositeKey}
                  />
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

Notes for the implementer:
- `cmdk` item `value`s must be unique across the list. That's why the Recent rows use the prefix `recent:` and the Not enabled rows use `enable:`. The selected model appears both in Recent and in its provider group.
- If `PopoverContent` doesn't accept `role` or `aria-label`, check `packages/ui/src/popover.tsx` and adapt, keeping an accessible dialog name. Don't add a `z-` class.
- If `cmdk` in happy-dom needs `scrollIntoView`, copy the stub the `ui` model-picker tests use into this test file. Don't change the global setup.

Update `assistant-ui-panel.tsx`:
- `:65`: `import { ComposerModelPicker, modelIdFromCompositeKey } from './composer-model-picker';`
- `:1426`: render `<ComposerModelPicker … onEnableModel={onEnableModel} />`, where `onEnableModel` is an optional prop on this component. Task 5 passes it down from the top-level panel.

Delete `composer-model-menu.tsx` and `composer-model-menu.test.tsx`. Then, from the worktree root, run `grep -rn "composer-model-menu\|ComposerModelMenu" packages apps --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v dist`. The only hits left should be the e2e specs Task 6 handles, plus `assistant-ui-panel.test.tsx`, which you update now by swapping `menuitemradio` for `option` and using search wherever it drilled through "More models".

- [ ] **Step 5: Run and verify**

Run: `pnpm --filter @brainstrike/assistant-ui exec vitest run composer-model-picker composer-picker-sections assistant-ui-panel`
Expected: PASS.
Run: `pnpm --filter @brainstrike/assistant-ui run type-check`.

- [ ] **Step 6: Mutate**

(a) Call `handlePick(entry)` unconditionally in `handleEnable`: the "leaves the selection unchanged" test must fail. (b) Remove `setQuery('')` from `handleOpenChange`: the Escape test must fail. Revert both.

- [ ] **Step 7: Commit**

```bash
git add packages/assistant-ui pnpm-lock.yaml
git commit -m "feat(BST-1795): search-first ComposerModelPicker replaces the nested dropdown"
```

---

### Task 5: Pass `onEnableModel` from the wrapper down to the picker

**Files:**
- Modify: `packages/assistant-ui/src/assistant-ui-panel.tsx`
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- Test: `packages/app-shell/src/__tests__/` (the wrapper suite; find it with `grep -rln "handleModelToggle\|onModelToggle" packages/app-shell/src`)

**Interfaces:**
- Consumes: `useModelToggle` from `@brainstrike/settings-ui/settings/models/use-model-toggle` (Task 2), and `ComposerModelPicker`'s `onEnableModel` (Task 4).
- Produces: `AssistantUiPanelProps.onEnableModel?: (providerId: string, modelId: string) => Promise<boolean>`. **Removes** `onModelToggle`.

- [ ] **Step 1: Write the failing test**

In the app-shell wrapper suite, add cases covering the handler passed as `onEnableModel`:
- for a hosted provider (`anthropic`, `claude-opus-5`), it calls `useModelToggle().toggle('claude-opus-5', true)` and resolves what `toggle` resolves;
- for a local-runtime provider (`ollama`), it resolves `false`, shows a destructive toast and does NOT call `toggle`.

Mock `@brainstrike/settings-ui/settings/models/use-model-toggle` to return `{ busyModelIds: new Set(), toggle: vi.fn().mockResolvedValue(true) }`. Capture the `onEnableModel` prop the wrapper hands to `AssistantUiPanel` the same way the existing wrapper tests capture other props; read them first.

- [ ] **Step 2: Run it and confirm it fails**

The prop doesn't exist yet.

- [ ] **Step 3: Implement**

`assistant-ui-panel.tsx`:
- Replace the declared-but-unused `onModelToggle?: (provider: string, model: string, enabled: boolean) => void;` (`:277`) with:
  ```ts
  /** Enable a registry-backed model from the picker; resolves true once committed. */
  onEnableModel?: (providerId: string, modelId: string) => Promise<boolean>;
  ```
- Pass `onEnableModel` along **every** path `onModelChange` takes to the composer dock. Each intermediate props interface that declares `onModelChange: ((compositeKey: string) => void) | undefined` gets `onEnableModel: ((providerId: string, modelId: string) => Promise<boolean>) | undefined` beside it, and each destructure/JSX site that passes `onModelChange={onModelChange}` passes `onEnableModel={onEnableModel}` beside it. Today `onModelChange` appears at lines 276, 411, 468, 573, 615, 758, 815, 855, 1046, 1088, 1205, 1261, 1395, 1415 and 1427. Follow it exactly, and don't restructure the file.

`assistant-ui-panel-wrapper.tsx`:
- Delete `handleModelToggle` (`:1042-1058`) and the `onModelToggle={handleModelToggle}` prop (`:1446`). Remove `toggleModelInDb` (`:221`) if nothing else reads it.
- Add, near the other model handlers:
  ```ts
  const { toggle: toggleModelEnabled } = useModelToggle();
  const handleEnableModel = useCallback(
    async (providerId: string, modelId: string): Promise<boolean> => {
      const runtime = isSupportedProvider(providerId)
        ? getProviderDefinition(providerId).runtime
        : undefined;
      // Same predicate the picker uses to offer the row: only hosted and gateway
      // providers keep enablement in the model registry.
      if (runtime !== 'hosted' && runtime !== 'gateway') {
        toast({
          description: `${providerId} models are enabled by their runtime, not the model registry.`,
          title: 'Could not enable this model',
          variant: 'destructive',
        });
        return false;
      }
      return toggleModelEnabled(modelId, true);
    },
    [toast, toggleModelEnabled]
  );
  ```
  Pass `onEnableModel={handleEnableModel}` where `onModelToggle` was. Import `useModelToggle` from `@brainstrike/settings-ui/settings/models/use-model-toggle`, and `getProviderDefinition` from wherever the wrapper already gets provider metadata (it imports `isSupportedProvider`; use the same module). If the wrapper doesn't already have `toast` from `useToast()`, add it.
- Drop any import left unused (`isLocalRuntimeProvider`, `toggleModelInDb`) only if nothing else uses it. Let type-check and Biome confirm.

- [ ] **Step 4: Run and verify**

Run: `pnpm --filter @brainstrike/app-shell exec vitest run assistant-ui-panel-wrapper` and `pnpm --filter @brainstrike/assistant-ui exec vitest run assistant-ui-panel`.
Run: `pnpm --filter @brainstrike/assistant-ui run type-check` and `pnpm --filter @brainstrike/app-shell run type-check`.
Then confirm nothing still references the removed prop: `grep -rn "onModelToggle\|handleModelToggle" packages apps --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v dist` must print nothing.

- [ ] **Step 5: Mutate**

Change the runtime check to allow `'local'`: the ollama test must fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add packages/assistant-ui/src/assistant-ui-panel.tsx packages/app-shell
git commit -m "feat(BST-1795): enable a model from the picker through useModelToggle; drop the silent onModelToggle"
```

---

### Task 6: E2E specs and live verification

**Files:**
- Modify: `apps/web/e2e/assistant-panel.test.ts`, `apps/web/e2e/assistant-ui-panel.test.ts`, `apps/desktop/e2e/delegated-child-control.desktop.test.ts`, `apps/desktop/e2e/secrets-settings.test.ts`

- [ ] **Step 1: Rewrite the model selection in each spec**

Each spec currently clicks `composer-model-menu-trigger`, then `composer-more-models-trigger`, drills through submenus and clicks a `menuitemradio`. Replace that with the search flow, keeping each spec's intent and the model it picks:

```ts
await page.getByTestId('composer-model-menu-trigger').click();
await page.getByRole('combobox').fill('Claude Sonnet 5');
await page.getByRole('option', { name: /^Claude Sonnet 5/ }).click();
```

In the desktop specs, use the spec's existing `window` / `root` locators rather than `page`. Keep every existing assertion about the trigger text afterwards. Before Playwright interacts with the popup, wait with `waitForFloatingLayerStack(page, '[role="dialog"]')` from `apps/web/e2e/utils/layout-helpers.ts` wherever the spec already guards other floating layers that way (`docs/agents/ui-conventions.md`, "Layer registration is not synchronous").

- [ ] **Step 2: Run the web specs locally**

Run the two web specs non-interactively, following `apps/web`'s e2e instructions (read `docs/agents/ci-quality.md` and the web e2e README first; the web e2e server serves `dist`, so rebuild before running). Expected: PASS. The desktop specs run in CI on the PR; if they can't run locally, say so in the report.

- [ ] **Step 3: Live verification with screenshots**

Launch the web app from the worktree (`.claude/launch.json` is gitignored; add a configuration pointing `pnpm --filter @brainstrike/web dev` at this worktree, port 8080, and start it with `preview_start`). With at least one provider configured:
1. Open the picker. Take a screenshot of the empty-query view (Recent plus grouped headings).
2. Type a query that matches enabled models across two providers. Take a screenshot showing the provider labels.
3. Type a query that matches a disabled registry-backed model. Pick it and confirm it becomes selected and now appears in Settings → Models as enabled. Take a screenshot.
4. Press Escape, reopen, and confirm the query is empty.
Also check `read_console_messages` for errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e apps/desktop/e2e
git commit -m "test(BST-1795): pick composer models by search in e2e"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §2 trigger unchanged | 4 |
| §2 opening, focus on search | 4 |
| §2 empty-query Recent + groups | 3, 4 |
| §2 typed flatten + provider labels | 3, 4 |
| §2 Not enabled + enable-then-select | 3, 4, 5 |
| §2 registry-backed only | 3 (`REGISTRY_BACKED_RUNTIMES`), 5 (same runtime predicate in the wrapper) |
| §2 matching | 1 |
| §2 rows, including the amended Not enabled rows | 4 |
| §2 keyboard, Escape clears query | 4 |
| §3 units | 1–5 |
| §4 constraints | Global Constraints, Task 4 notes |
| §5 tests | a test step and a mutation in every task |
| Live check | 6 |

The e2e dependencies the spec didn't list are handled in Task 6.

**Placeholders:** Task 4's test step compresses repeated fixture-driven cases into described comments and names the exact assertions for each. Everything else carries complete code.

**Type consistency:**
- `onEnableModel: (providerId: string, modelId: string) => Promise<boolean>` is identical in Tasks 4 and 5.
- `useModelToggle().toggle` returns `Promise<boolean>` in Tasks 2 and 5.
- `ComposerPickerEntry` fields are used identically in Tasks 3 and 4.
- `matchesModelQuery(fields, query)` has the same shape in Tasks 1 and 3.
- The registry-backed rule is the runtime ∈ {hosted, gateway} in both Task 3 and Task 5.
