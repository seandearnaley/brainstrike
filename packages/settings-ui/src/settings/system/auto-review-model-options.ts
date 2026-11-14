import type { DbModel, DbProvider } from '@brainstrike/app-state/stores/model-registry-store';
import { modelVendor } from '@brainstrike/assistant-contract/model-vendors';
import { findModelVendor } from '@brainstrike/assistant-contract/provider-registry';
import { modelMarkLabel } from '@brainstrike/ui';

export interface AutoReviewModelOption {
  /** The model's name; its mark carries its maker and route. */
  label: string;
  /** "Anthropic via OpenRouter": the mark's accessible name. */
  markLabel: string;
  modelId: string;
  providerId: string;
  /** The `provider/model` target the policy stores. */
  target: string;
  vendor?: string;
}

/** The providers whose models the auto-review picker offers. */
const REVIEW_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'openrouter']);

function providerById(providers: readonly DbProvider[]): Map<string, DbProvider> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

function compareOptions(providers: Map<string, DbProvider>, left: DbModel, right: DbModel): number {
  const leftProvider = providers.get(left.providerId);
  const rightProvider = providers.get(right.providerId);
  return (
    (leftProvider?.sortOrder ?? 0) - (rightProvider?.sortOrder ?? 0) ||
    left.sortOrder - right.sortOrder ||
    left.name.localeCompare(right.name)
  );
}

function toOption(provider: DbProvider, model: DbModel): AutoReviewModelOption {
  const vendor = findModelVendor(provider.id, model.id);
  const maker = vendor ? modelVendor(vendor) : undefined;
  return {
    label: model.name,
    markLabel: modelMarkLabel({
      providerId: provider.id,
      providerName: provider.name,
      vendorId: maker?.id,
      vendorName: maker?.name,
    }),
    modelId: model.id,
    providerId: provider.id,
    target: `${provider.id}/${model.id}`,
    ...(maker ? { vendor: maker.id } : {}),
  };
}

/** The enabled models of enabled review providers, in catalog order. */
export function listAutoReviewModelOptions(args: {
  models: readonly DbModel[];
  providers: readonly DbProvider[];
}): readonly AutoReviewModelOption[] {
  const providers = providerById(args.providers);
  return args.models
    .filter(
      (model) =>
        REVIEW_PROVIDER_IDS.has(model.providerId) &&
        providers.get(model.providerId)?.isEnabled === true &&
        model.isEnabled
    )
    .sort((left, right) => compareOptions(providers, left, right))
    .map((model) => toOption(providers.get(model.providerId) as DbProvider, model));
}
