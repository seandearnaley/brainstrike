# BST-1795 — Searchable composer model picker

**Ticket:** BST-1795 · **Date:** 2026-09-22 · **Status:** draft for review · **Scope:** replace `ComposerModelMenu` (`packages/assistant-ui/src/composer-model-menu.tsx`) with a searchable picker; share one matcher with `packages/ui/src/model-picker`; route inline enablement through Settings' `useModelToggle`. No schema change, no catalog change, no migration.

This document is the design output. The task-by-task implementation plan follows once it is approved.

## 1. Problem

The composer selects a model through a Radix `DropdownMenu` with a Recent section at the top (the selected model plus up to four recents), then **More models** → runtime group → provider → model. That's three levels of submenu with no search and no filtering. It holds up today mostly because few models are enabled. BST-1794 turns on every first-party catalog model, about 30 across OpenAI, Anthropic and Google, and OpenRouter has another 53 routes in the catalog that stay disabled.

Other constraints found while exploring:

- `packages/ui/src/model-picker` is already searchable: a `Popover` containing `cmdk`'s `Command`. But it was built for choosing embedding models. Its rows are 56px, three lines tall, with "Streaming" and dimension chips. It marks the provider only with a colour dot. It groups by provider only. It **selects by bare `model.id`**. It declares a `renderItem` prop that it never uses.
- The composer's selection is `provider::model` from end to end, because resolving a bare id back to a provider has been a bug before. Bare ids don't collide in the static catalog today, but Ollama and LM Studio models are discovered at runtime and can collide.
- **Display labels already collide:** `GPT-5.5`, `GPT-5.4` and `GPT-5.4 Mini` each exist under both `openai` and `openai-codex`.
- A text input inside a Radix `DropdownMenu` fights the menu's type-ahead for keystrokes. Popover + `cmdk` is the standard shape for a searchable picker.
- `AssistantUiPanel` declares `onModelToggle` (`assistant-ui-panel.tsx:277`) and never reads it. The wrapper's `handleModelToggle`, which feeds it, fails silently in four ways: it returns without a word for an unsupported provider, for a local-runtime provider and when `db` is null, and it discards a rejected write (`void toggleModelInDb(...)`). Settings' `useModelToggle` exists specifically to report both kinds of failure.

## 2. Behaviour

### Trigger

The trigger is unchanged: a pill showing the provider dot and the model label.

### Opening

A `Popover` opens and the search box takes focus.

**Empty query:**

1. **Recent**: the selected model plus up to four recents, chosen by today's `collectTopOptionKeys` rule, falling back to models flagged `default`. These are two-line rows that include the tagline.
2. Every **enabled** model, grouped under a heading such as `HOSTED · ANTHROPIC` with a count, in today's runtime order: Hosted, Gateway, Local, Browser.

Disabled models aren't shown until you type. The default view is the enabled set.

**Non-empty query:**

1. **Enabled matches** as one flat list, each row labelled with its provider's display name.
2. **Not enabled**: disabled matches from registry-backed providers, each with a ＋ affordance.

### Picking a disabled model

1. Call `onEnableModel(providerId, modelId)`. It returns `Promise<boolean>`.
2. If it resolves `true`, select that model through the existing `onModelChange(compositeKey)`.
3. If it resolves `false`, leave the selection alone. The host has already shown an error toast, so the picker adds nothing of its own. No silent path.

A model enabled this way goes through `toggleModel`, which writes `updated_at`. That makes it "touched" under BST-1794, so no default policy will ever override it.

### Which providers appear under Not enabled

The Not enabled section covers **registry-backed** providers only: configured providers whose enablement lives in the `models` table. It leaves out:

- `ollama` and `lmstudio`, whose enablement comes from runtime discovery;
- `local`, which is gated on a download.

### Matching

`matchesModelQuery(entry, query)`:

- Case-insensitive, split on whitespace, and **every** word must match.
- Each word is checked against the label, the bare model id, the provider display name, the provider id and the tagline.
- No fuzzy-matching dependency, consistent with the command palette's stated rule.
- An empty or whitespace-only query matches everything.

Results keep catalog order rather than a relevance score, so the output is deterministic.

### Rows

- **Recent rows:** label, tagline, context badge, vision/reasoning icons.
- **List rows:** one dense line with the label, the provider label (when the list is flattened), the context badge and the vision/reasoning icons.
- **Not enabled rows:** as list rows, plus a ＋ and an accessible name "Enable and select …".
- **No price column.** Prices are per-route estimates with long-context tiers and surge bands, so a bare number is misleading at a glance.

### Keyboard

From `cmdk`: arrow keys move, Enter picks, Escape closes. The query clears when the picker closes.

## 3. Structure

| Unit | Location | Responsibility |
| --- | --- | --- |
| `matchesModelQuery` | `packages/ui/src/model-picker/utils/match-model-query.ts` | The pure word matcher. `filterModels` in the embedding picker is rewritten on top of it (`name`→label, `description`→tagline, `id`→model id, `providerId`). Results can only **widen**, never narrow: a query now also matches the model id and the provider display name, and multi-word queries are AND-of-words rather than one contiguous substring. That's acceptable for the embedding picker, and its existing tests pin that nothing it already matched is lost |
| `buildComposerPickerSections` | `packages/assistant-ui/src/composer-picker-sections.ts` | Pure: `(providerGroups, pickerModels, recentModels, selectedModel, query)` → `{ recent, groups, matches, notEnabled }`. All the selection logic lives here, and it is unit-tested without React |
| `ComposerModelPicker` | `packages/assistant-ui/src/composer-model-picker.tsx` | Popover + `Command` + `ModelPickerSearch`. Reuses `ProviderIcon`, `getProviderColor` and `formatContextWindow` from `@brainstrike/ui`. `shouldFilter={false}`, and each item's `value` is the composite key |
| `ComposerModelMenu` | deleted | Replaced by `ComposerModelPicker`. `composerModelCompositeKey` and `modelIdFromCompositeKey` move with the replacement and stay exported |
| `onEnableModel` | `AssistantUiPanel` prop | `(providerId, modelId) => Promise<boolean>`. Replaces the dead `onModelToggle` |
| `useModelToggle` | `packages/settings-ui/src/settings/models/use-model-toggle.ts` | `toggle` returns `Promise<boolean>`: `true` once the write commits, `false` after it has shown the toast. The two current callers ignore the return value and keep working. A `./settings/models/use-model-toggle` subpath export is added |
| `handleModelToggle` | `assistant-ui-panel-wrapper.tsx` | Deleted. The wrapper passes `onEnableModel` built on `useModelToggle`, returning `false` without writing for a provider that isn't registry-backed |

The package boundaries hold. `assistant-ui` depends only on `@brainstrike/ui` and calls back into its host. `app-shell` already depends on `settings-ui`. `providerGroups`, built by `useAssistantModelPickerConfig`, already carries every catalog model with its `enabled` flag, so no new data needs to flow in.

Why `cmdk`'s built-in filter is off: it scores each item's `value` string, which here is the composite key and not the label the user reads, and it ranks results where this design wants catalog order.

## 4. Constraints from the repo contracts

- **Stacking:** the shared `PopoverContent` applies `POPUP_LAYER_CLASS`. No hardcoded `z-` (ui-conventions, "Floating layer stacking").
- **Anchoring:** no transform, zoom or scale on the trigger or any wrapper around it (ui-conventions, "Floating layer anchoring").
- **Tests:** assert which layer is on top or hidden, never whether something is clickable, because Radix drops `pointer-events` on inner layers (ui-conventions).
- **Styling:** Tailwind v4 through `@brainstrike/ui` tokens. Class names are literal strings.
- **TypeScript:** strict, never `any`, kebab-case filenames.

## 5. Testing

- **`matchesModelQuery`**, table-driven:
  - words matched against each field;
  - multi-word AND (`"opus bedrock"`);
  - case-insensitivity;
  - empty and whitespace-only queries;
  - a word matching the provider display name but not the id, and the reverse.
- **`filterModels`:** the existing tests keep passing unchanged.
- **`buildComposerPickerSections`:**
  - Recent follows today's `collectTopOptionKeys` rule, including the fallback to `default`-flagged models;
  - an empty query hides disabled models;
  - a query flattens enabled matches and keeps catalog order;
  - colliding labels (`GPT-5.5` under `openai` and `openai-codex`) come back as two entries with different composite keys and provider labels;
  - `ollama`, `lmstudio` and `local` never appear under Not enabled;
  - a query with no matches returns every section empty.
- **`ComposerModelPicker`** (component):
  - opening focuses search;
  - Escape closes the picker and clears the query;
  - picking an enabled row calls `onModelChange` with the composite key;
  - picking a Not enabled row calls `onEnableModel` and then `onModelChange` **only** after it resolves `true`;
  - a `false` result doesn't call `onModelChange`.
  - The 9 existing `composer-model-menu.test.tsx` cases are ported, not dropped.
- **`useModelToggle`:** returns `true` after a committed write, and `false` both when `db` is missing and when the write rejects, with the toast shown in both failure cases.
- **Live:** run the web app with env-provided keys, or the desktop app via the CDT hosted-mock recipe. Search for a disabled OpenRouter route, pick it, and confirm it's enabled and selected. Take screenshots of the empty-query view and the searching view.

## 6. Out of scope

- A shared compound picker (`ModelPicker.Root/Search/List/Item`) that both pickers assemble. If a third picker shows up, that's a separate ticket.
- A price column.
- A keyboard shortcut to open the picker.
- Model metadata sourcing (BST-1359) and enablement policy (BST-1794).
