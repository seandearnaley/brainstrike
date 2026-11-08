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
import { modelVendor } from '@brainstrike/assistant-contract/model-vendors';
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
  /** `provider::model`. */
  readonly id: string;
  readonly isEnabled: boolean;
  readonly label: string;
  readonly markLabel: string;
  readonly provider: string;
  readonly vendor?: string | undefined;
}

function catalogModels(
  models: readonly DbModel[],
  providers: readonly DbProvider[]
): readonly CatalogModel[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return [...models]
    .sort(
      (left, right) =>
        (byId.get(left.providerId)?.sortOrder ?? 0) -
          (byId.get(right.providerId)?.sortOrder ?? 0) || left.sortOrder - right.sortOrder
    )
    .map((model) => {
      const vendor = findModelVendor(model.providerId, model.id);
      const maker = vendor ? modelVendor(vendor) : undefined;
      return {
        id: `${model.providerId}::${model.id}`,
        isEnabled: model.isEnabled,
        label: model.name,
        markLabel: modelMarkLabel({
          providerId: model.providerId,
          providerName: byId.get(model.providerId)?.name ?? model.providerId,
          vendorId: maker?.id,
          vendorName: maker?.name,
        }),
        provider: model.providerId,
        vendor: maker?.id,
      };
    });
}

/** Why an allowed model cannot run now; nothing when it can. */
function rowStatus(
  model: CatalogModel | undefined,
  withKeys: ReadonlySet<string> | undefined
): string | undefined {
  if (!model) {
    return 'Not in the catalog';
  }
  if (!model.isEnabled) {
    return 'Not enabled';
  }
  return withKeys && !withKeys.has(model.provider) ? 'Provider not connected' : undefined;
}

export function SubagentModelsSection({
  configuredProviders,
  providersError,
}: {
  /**
   * The providers the host can run, as the composer's picker reads them;
   * absent while that is unknown, when no model is offered.
   */
  readonly configuredProviders?: readonly string[] | undefined;
  /** Why the providers could not be read. */
  readonly providersError?: string | undefined;
}) {
  useEnsureModelRegistry();
  const { error, hasLoaded, models, providers } = useModelRegistryStore(
    useShallow((state) => ({
      error: state.error,
      hasLoaded: state.hasLoaded,
      models: state.models,
      providers: state.providers,
    }))
  );
  const { allowed, setModels } = useAssistantSubagentPreferencesStore(
    useShallow((state) => ({ allowed: state.models, setModels: state.setModels }))
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const catalog = catalogModels(models, providers);
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const withKeys = configuredProviders ? new Set<string>(configuredProviders) : undefined;
  const loaded = hasLoaded && !error;
  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setQuery('');
    }
  };
  const addable =
    loaded && withKeys
      ? catalog.filter(
          (model) => model.isEnabled && withKeys.has(model.provider) && !allowed.includes(model.id)
        )
      : [];
  const options: ModelMenuOption[] = addable
    .filter((model) =>
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
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          The model catalog didn’t load: {error}
        </p>
      ) : null}
      {providersError ? (
        <p className="text-destructive text-sm" role="alert">
          The connected providers didn’t load: {providersError}
        </p>
      ) : null}
      {allowed.length > 0 ? (
        <ul aria-labelledby="subagent-models-heading" className="divide-border divide-y">
          {allowed.map((id) => {
            const model = byId.get(id);
            const provider = model?.provider ?? id.slice(0, Math.max(id.indexOf('::'), 0));
            const label = model?.label ?? id;
            // A status speaks only once the catalog it reads has loaded.
            const status = loaded ? rowStatus(model, withKeys) : undefined;
            return (
              <li className="flex items-center gap-2 py-1.5 text-sm" key={id}>
                <ModelMark label={model?.markLabel} provider={provider} vendor={model?.vendor} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {status ? <span className="text-destructive text-xs">{status}</span> : null}
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
          <Button
            className="gap-1.5"
            disabled={addable.length === 0}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" className="size-4" />
            Add model
          </Button>
        }
      />
    </Card>
  );
}
