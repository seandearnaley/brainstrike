/**
 * ADR-0037: the models a delegation may name. A subagent runs on its
 * persona's pinned model, else on one of these when its delegation names one,
 * else on its parent's model; none listed, delegations name no model.
 */
import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useAssistantSubagentPreferencesStore } from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import {
  type DbModel,
  type DbProvider,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import { modelVendor } from '@brainstrike/assistant-contract/model-vendors';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { findModelVendor } from '@brainstrike/assistant-contract/provider-registry';
import {
  Button,
  Card,
  ModelMark,
  ModelMenu,
  type ModelMenuOption,
  matchesModelQuery,
  modelMarkLabel,
} from '@brainstrike/ui';
import { Cpu, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

interface CatalogModel {
  readonly id: string;
  readonly label: string;
  readonly markLabel: string;
  readonly provider: string;
  readonly vendor?: string | undefined;
}

/**
 * Every enabled model of a provider with a key, in catalog order, keyed
 * `provider::model`: the composer's own gate, so a model the host could not
 * admit is not offered.
 */
function enabledModels(
  models: readonly DbModel[],
  providers: readonly DbProvider[],
  withKeys: ReadonlySet<string> | undefined
): readonly CatalogModel[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return models
    .filter(
      (model) => model.isEnabled && (withKeys === undefined || withKeys.has(model.providerId))
    )
    .sort(
      (left, right) =>
        (byId.get(left.providerId)?.sortOrder ?? 0) -
          (byId.get(right.providerId)?.sortOrder ?? 0) || left.sortOrder - right.sortOrder
    )
    .map((model) => {
      const provider = byId.get(model.providerId);
      const vendor = findModelVendor(model.providerId, model.id);
      const maker = vendor ? modelVendor(vendor) : undefined;
      return {
        id: `${model.providerId}::${model.id}`,
        label: model.name,
        markLabel: modelMarkLabel({
          providerId: model.providerId,
          providerName: provider?.name ?? model.providerId,
          vendorId: maker?.id,
          vendorName: maker?.name,
        }),
        provider: model.providerId,
        vendor: maker?.id,
      };
    });
}

export function SubagentModelsSection({
  providerKeySources,
}: {
  /** The providers with a key; absent, every enabled provider's models are offered. */
  readonly providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
}) {
  useEnsureModelRegistry();
  const { models, providers } = useModelRegistryStore(
    useShallow((state) => ({ models: state.models, providers: state.providers }))
  );
  const { allowed, setModels } = useAssistantSubagentPreferencesStore(
    useShallow((state) => ({ allowed: state.models, setModels: state.setModels }))
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const catalog = enabledModels(
    models,
    providers,
    providerKeySources ? new Set(providerKeySources.map(({ provider }) => provider)) : undefined
  );
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setQuery('');
    }
  };
  const options: ModelMenuOption[] = catalog
    .filter(
      (model) =>
        !allowed.includes(model.id) &&
        matchesModelQuery(
          {
            label: model.label,
            modelId: model.id,
            providerId: model.provider,
            providerName: model.markLabel,
          },
          query
        )
    )
    .map((model) => ({
      key: model.id,
      label: model.label,
      markLabel: model.markLabel,
      onSelect: () => {
        setModels([...allowed, model.id]);
        close(false);
      },
      provider: model.provider,
      vendor: model.vendor,
    }));

  return (
    <Card className="space-y-3 p-4" data-testid="subagent-models-section">
      <div className="flex items-center gap-2">
        <Cpu aria-hidden="true" className="text-muted-foreground h-4 w-4" />
        <h3 className="text-sm font-medium" id="subagent-models-heading">
          Models subagents may run on
        </h3>
      </div>
      {allowed.length > 0 ? (
        <ul aria-labelledby="subagent-models-heading" className="divide-border divide-y">
          {allowed.map((id) => {
            const model = byId.get(id);
            const separator = id.indexOf('::');
            const provider = model?.provider ?? id.slice(0, Math.max(separator, 0));
            const label = model?.label ?? id;
            return (
              <li className="flex items-center gap-2 py-1.5 text-sm" key={id}>
                <ModelMark label={model?.markLabel} provider={provider} vendor={model?.vendor} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {model ? null : <span className="text-destructive text-xs">Not enabled</span>}
                <Button
                  aria-label={`Remove ${label}`}
                  className="size-7"
                  onClick={() => setModels(allowed.filter((other) => other !== id))}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ModelMenu
        aria-label="Add a model subagents may run on"
        groups={[{ key: 'models', options }]}
        onOpenChange={close}
        onQueryChange={setQuery}
        open={open}
        query={query}
        trigger={
          <Button className="gap-1.5" size="sm" type="button" variant="outline">
            <Plus aria-hidden="true" className="size-4" />
            Add model
          </Button>
        }
      />
    </Card>
  );
}
