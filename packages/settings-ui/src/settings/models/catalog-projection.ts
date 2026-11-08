import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import {
  type ModelReasoningSupport,
  type ReasoningControlsAvailability,
  resolveModelReasoningSupport,
  resolveReasoningControlsAvailability,
} from '@brainstrike/assistant-contract/model-reasoning';
import { type ModelVendor, modelVendor } from '@brainstrike/assistant-contract/model-vendors';
import {
  findProviderDefinition,
  type ModelVisionSupport,
  type ProviderModelDefinition,
} from '@brainstrike/assistant-contract/provider-registry';

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
  readonly enabled: boolean;
  readonly id: string;
  readonly maxOutputTokens: number | null;
  readonly name: string;
  readonly pricing: CatalogPricing | null;
  readonly providerId: string;
  readonly providerName: string;
  /** `null` when there is no signal at all (provider absent from the registry). */
  readonly reasoning: ModelReasoningSupport | null;
  /** The offered effort/level ladder; only set when reasoning is `supported`. */
  readonly reasoningEfforts: readonly string[] | null;
  readonly recommended: boolean;
  /** Whether the static registry has an entry for this exact model. */
  readonly registered: boolean;
  readonly tagline: string | null;
  /** The model's maker, for its mark; absent for a model the static registry doesn't list. */
  readonly vendor?: ModelVendor | undefined;
  readonly vision: ModelVisionSupport | null;
}

function findRegistryModel(model: DbModel): ProviderModelDefinition | undefined {
  return findProviderDefinition(model.providerId)?.models.find(
    (definition) => definition.id === model.id
  );
}

function toPricing(definition: ProviderModelDefinition | undefined): CatalogPricing | null {
  if (!definition?.pricing) {
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

export function projectCatalogRow(model: DbModel, providerName: string): CatalogRow {
  const definition = findRegistryModel(model);
  const providerKnown = findProviderDefinition(model.providerId) !== undefined;
  const reasoning = providerKnown ? resolveModelReasoningSupport(model.providerId, model.id) : null;
  return {
    bestFor: Array.isArray(model.bestFor) ? model.bestFor : [],
    contextWindow: definition?.contextWindow ?? null,
    description: model.description,
    enabled: model.isEnabled,
    id: model.id,
    maxOutputTokens: definition?.maxOutputTokens ?? null,
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
    tagline: model.tagline,
    ...(definition ? { vendor: modelVendor(definition.vendor) } : {}),
    vision: definition?.vision ?? null,
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
