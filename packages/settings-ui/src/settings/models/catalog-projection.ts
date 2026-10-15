import { isLocalModelProviderId } from '@brainstrike/app-state/models/local-model-utils';
import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import {
  type ModelReasoningSupport,
  type ReasoningControlsAvailability,
  resolveModelReasoningSupport,
  resolveReasoningControlsAvailability,
} from '@brainstrike/assistant-contract/model-reasoning';
import {
  findProviderDefinition,
  type ModelVisionSupport,
  type ProviderModelDefinition,
} from '@brainstrike/assistant-contract/provider-registry';

export type CatalogModelType = 'chat' | 'embedding';

export interface CatalogPricing {
  readonly cacheReadPerMTok: number | null;
  readonly cacheWritePerMTok: number | null;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * One Model Catalog row: the DB row (the catalog of record — name, copy,
 * enabled state, order) joined with the static registry's facts (context,
 * pricing, capabilities). Absence is explicit: a fact the registry does not
 * publish is `null`, never 0 (BST-1805 design §2, principle 6).
 */
export interface CatalogRow {
  readonly bestFor: readonly string[];
  readonly contextWindow: number | null;
  readonly description: string | null;
  /** Embedding output dimension; `null` for chat rows. */
  readonly dimension: number | null;
  readonly enabled: boolean;
  readonly id: string;
  /** A downloadable on-device model (`local`, `transformers`). */
  readonly isLocal: boolean;
  readonly maxOutputTokens: number | null;
  readonly name: string;
  readonly pricing: CatalogPricing | null;
  readonly providerId: string;
  readonly providerName: string;
  /** `null` when there is no signal at all (embedding row, or provider absent from the registry). */
  readonly reasoning: ModelReasoningSupport | null;
  /** The offered effort/level ladder; only set when reasoning is `supported`. */
  readonly reasoningEfforts: readonly string[] | null;
  readonly recommended: boolean;
  /** Whether the static registry has an entry for this exact model. */
  readonly registered: boolean;
  readonly sizeLabel: string | null;
  readonly tagline: string | null;
  readonly type: CatalogModelType;
  readonly vision: ModelVisionSupport | null;
}

function findRegistryModel(model: DbModel): ProviderModelDefinition | undefined {
  return findProviderDefinition(model.providerId)?.models.find(
    (definition) => definition.id === model.id && definition.type === model.capabilities.type
  );
}

function toPricing(definition: ProviderModelDefinition | undefined): CatalogPricing | null {
  if (definition?.type !== 'llm' || !definition.pricing) {
    return null;
  }
  const { cacheReadPerMTok, cacheWritePerMTok, inputPerMTok, outputPerMTok } = definition.pricing;
  return {
    cacheReadPerMTok: cacheReadPerMTok ?? null,
    cacheWritePerMTok: cacheWritePerMTok ?? null,
    inputPerMTok,
    outputPerMTok,
  };
}

function effortLadder(controls: ReasoningControlsAvailability): readonly string[] {
  if (!controls.available) {
    return [];
  }
  switch (controls.family) {
    case 'google':
      return controls.levels;
    default:
      return controls.efforts;
  }
}

function resolveSizeLabel(parameters: DbModel['parameters']): string | null {
  const size = parameters?.['size'];
  return typeof size === 'string' ? size : null;
}

export function projectCatalogRow(model: DbModel, providerName: string): CatalogRow {
  const definition = findRegistryModel(model);
  const llm = definition?.type === 'llm' ? definition : undefined;
  const type: CatalogModelType = model.capabilities.type === 'embedding' ? 'embedding' : 'chat';
  const providerKnown = findProviderDefinition(model.providerId) !== undefined;
  const reasoning =
    type === 'chat' && providerKnown
      ? resolveModelReasoningSupport(model.providerId, model.id)
      : null;
  return {
    bestFor: Array.isArray(model.bestFor) ? model.bestFor : [],
    contextWindow: llm?.contextWindow ?? null,
    description: model.description,
    dimension: type === 'embedding' ? (model.capabilities.defaultDimension ?? null) : null,
    enabled: model.isEnabled,
    id: model.id,
    isLocal: isLocalModelProviderId(model.providerId),
    maxOutputTokens: llm?.maxOutputTokens ?? null,
    name: model.name,
    pricing: toPricing(definition),
    providerId: model.providerId,
    providerName,
    reasoning,
    reasoningEfforts:
      reasoning?.state === 'supported'
        ? effortLadder(resolveReasoningControlsAvailability(model.providerId, model.id))
        : null,
    recommended: definition?.default === true,
    registered: definition !== undefined,
    sizeLabel: resolveSizeLabel(model.parameters),
    tagline: model.tagline,
    type,
    vision: llm?.vision ?? null,
  };
}

/**
 * Memoised projection keyed on DbModel IDENTITY. The store replaces only the
 * toggled model's object, so a toggle re-projects one row and every other
 * CatalogRow — and the TreeNodes built from it — keeps its identity (TreeGrid
 * row-identity contract, docs/agents/ui-conventions.md).
 */
export function createCatalogProjector(): (model: DbModel, providerName: string) => CatalogRow {
  const cache = new WeakMap<DbModel, CatalogRow>();
  return (model, providerName) => {
    const cached = cache.get(model);
    if (cached && cached.providerName === providerName) {
      return cached;
    }
    const row = projectCatalogRow(model, providerName);
    cache.set(model, row);
    return row;
  };
}
