/**
 * Pure selection logic for the composer model picker (BST-1795). Selection is
 * COMPOSITE-KEY ("provider::model") end to end — the picker never resolves a
 * bare model id back to a provider.
 */
import { type ModelPickerModel, matchesModelQuery } from '@brainstrike/ui';
import type { ProviderGroupConfig, ProviderRuntimeCategory } from './assistant-ui-panel';

const MAX_RECENT_ROWS = 4;
const MODEL_KEY_DELIMITER = '::';

/**
 * Runtimes whose enablement lives in the model registry. `local` runtimes
 * (Ollama, LM Studio) enable by discovery and `browser` (built-in local) by
 * download, so the picker never offers to enable them.
 */
const REGISTRY_BACKED_RUNTIMES: ReadonlySet<ProviderRuntimeCategory> =
  new Set<ProviderRuntimeCategory>(['hosted', 'gateway']);

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
        !entry.isEnabled &&
        REGISTRY_BACKED_RUNTIMES.has(entry.runtime) &&
        entryMatches(entry, args.query)
    ),
    recent: [],
  };
}
