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
  isArchivedModel,
  type ModelLifecycleStatus,
  type ModelPricingRates,
  type ModelVisionSupport,
  nextPricingChangeAfter,
  type ProviderModelDefinition,
  pricingInForceAt,
} from '@brainstrike/assistant-contract/provider-registry';

export interface CatalogRates {
  readonly cacheReadPerMTok: number | null;
  readonly cacheWritePerMTok: number | null;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/** A price change the vendor has announced, from 00:00 UTC on `effectiveFrom` (`YYYY-MM-DD`). */
export interface CatalogPriceChange extends CatalogRates {
  readonly effectiveFrom: string;
}

/** The rates in force when the catalog opened, and the next announced change. */
export interface CatalogPricing extends CatalogRates {
  readonly nextChange: CatalogPriceChange | null;
}

/** Where the model stands with its vendor, from the registry's `lifecycle`. */
export interface CatalogLifecycle {
  /** Legacy or deprecated: hidden unless Show archived is on or the row is enabled. */
  readonly archived: boolean;
  /** The successor's display name, when the vendor names one. */
  readonly replacedBy: string | null;
  /** The vendor's shutdown day (`YYYY-MM-DD`), when announced. */
  readonly retiresAt: string | null;
  readonly status: ModelLifecycleStatus;
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
  /** `null` for a row the static registry doesn't list. */
  readonly lifecycle: CatalogLifecycle | null;
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

function toRates({
  cacheReadPerMTok,
  cacheWritePerMTok,
  inputPerMTok,
  outputPerMTok,
}: ModelPricingRates): CatalogRates {
  return {
    cacheReadPerMTok: cacheReadPerMTok ?? null,
    cacheWritePerMTok: cacheWritePerMTok ?? null,
    inputPerMTok,
    outputPerMTok,
  };
}

function toPricing(
  definition: ProviderModelDefinition | undefined,
  nowMs: number
): CatalogPricing | null {
  if (!definition?.pricing) {
    return null;
  }
  const next = nextPricingChangeAfter(definition.pricing, nowMs);
  return {
    ...toRates(pricingInForceAt(definition.pricing, nowMs)),
    nextChange: next ? { ...toRates(next), effectiveFrom: next.effectiveFrom } : null,
  };
}

function toLifecycle(
  providerId: string,
  definition: ProviderModelDefinition | undefined
): CatalogLifecycle | null {
  if (!definition) {
    return null;
  }
  const { lifecycle } = definition;
  const successorId = lifecycle?.replacedBy;
  const successor =
    successorId === undefined
      ? undefined
      : findProviderDefinition(providerId)?.models.find((model) => model.id === successorId);
  return {
    archived: isArchivedModel(definition),
    replacedBy: successor === undefined ? null : (successor.catalog?.name ?? successor.id),
    retiresAt: lifecycle?.retiresAt ?? null,
    status: lifecycle?.status ?? 'active',
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

/** `nowMs` picks the rates in force, so a dated price change shows from its day on. */
export function projectCatalogRow(model: DbModel, providerName: string, nowMs: number): CatalogRow {
  const definition = findRegistryModel(model);
  const providerKnown = findProviderDefinition(model.providerId) !== undefined;
  const reasoning = providerKnown ? resolveModelReasoningSupport(model.providerId, model.id) : null;
  return {
    bestFor: Array.isArray(model.bestFor) ? model.bestFor : [],
    contextWindow: definition?.contextWindow ?? null,
    description: model.description,
    enabled: model.isEnabled,
    id: model.id,
    lifecycle: toLifecycle(model.providerId, definition),
    maxOutputTokens: definition?.maxOutputTokens ?? null,
    name: model.name,
    pricing: toPricing(definition, nowMs),
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
 * row-identity contract, docs/agents/ui-conventions.md). Prices are those in
 * force at `nowMs`, the moment the catalog opened.
 */
export function createCatalogProjector(
  nowMs: number
): (model: DbModel, providerName: string) => CatalogRow {
  const cache = new WeakMap<DbModel, CatalogRow>();
  return (model, providerName) => {
    const cached = cache.get(model);
    if (cached && cached.providerName === providerName) {
      return cached;
    }
    const row = projectCatalogRow(model, providerName, nowMs);
    cache.set(model, row);
    return row;
  };
}
