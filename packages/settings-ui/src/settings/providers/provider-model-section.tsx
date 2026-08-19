import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import { Badge, Button, cn, Switch } from '@brainstrike/ui';
import { useState } from 'react';

/**
 * Recommended models are the registry's own defaults for the provider — the
 * ones its vendor considers a sensible starting point. They are BADGED and
 * sorted first rather than focused: moving focus on an automatic event steals
 * the caret and scrolls the panel under the user, and the badge communicates
 * the same thing without touching their cursor.
 */
export interface ProviderModelSectionProps {
  readonly busyModelIds: ReadonlySet<string>;
  readonly models: readonly DbModel[];
  readonly onToggle: (modelId: string, enabled: boolean) => void;
  readonly providerId: string;
  readonly recommendedModelIds: ReadonlySet<string>;
}

function ModelTypeBadge({ model }: { readonly model: DbModel }) {
  return (
    <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
      {model.capabilities.type === 'embedding' ? 'Embedding' : 'Chat'}
    </Badge>
  );
}

export function ProviderModelSection({
  busyModelIds,
  models,
  onToggle,
  providerId,
  recommendedModelIds,
}: ProviderModelSectionProps) {
  // Recommended first, then enabled, then catalog order — so the models the
  // user most likely wants are the ones they see without scrolling.
  //
  // The order is FROZEN once the section is open: ranking on `isEnabled` live
  // would make every toggle reorder the list under the pointer, so the row the
  // user just clicked jumps away and the next click lands on a different
  // model. Re-ranked only when the provider changes or its catalog does — the
  // same stability the Model Catalog list has.
  const orderKey = `${providerId}:${models.map((model) => model.id).join(',')}`;

  // Derived state adjusted DURING RENDER — React's sanctioned alternative to
  // both a hand-trimmed `useMemo` dependency list and a ref mutated in render.
  // The rank reads `isEnabled`, so depending on `models` would re-sort on every
  // toggle (the jump this prevents), while omitting it is the stale-closure
  // shape `exhaustive-deps` warns about. Re-ranking only when the membership
  // key changes avoids both, and always ranks the CURRENT models.
  const [frozenOrder, setFrozenOrder] = useState<{ ids: readonly string[]; key: string }>({
    ids: [],
    key: '',
  });
  if (frozenOrder.key !== orderKey) {
    const rank = (model: DbModel): number => {
      if (recommendedModelIds.has(model.id)) {
        return 0;
      }
      return model.isEnabled ? 1 : 2;
    };
    setFrozenOrder({
      ids: [...models].sort((left, right) => rank(left) - rank(right)).map((model) => model.id),
      key: orderKey,
    });
  }
  const orderedIds = frozenOrder.ids;

  // Only the ORDER is frozen. Rows still render live model data, so a toggle
  // updates its own switch immediately without anything moving.
  const byId = new Map(models.map((model) => [model.id, model]));
  const ordered = orderedIds.flatMap((id) => {
    const model = byId.get(id);
    return model ? [model] : [];
  });

  const enabledCount = models.filter((model) => model.isEnabled).length;

  if (models.length === 0) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-testid={`provider-models-empty-${providerId}`}
      >
        No models are catalogued for this provider yet.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid={`provider-models-${providerId}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-xs">Models</p>
        <p
          className="text-muted-foreground text-xs"
          data-testid={`provider-model-count-${providerId}`}
        >
          {models.length} {models.length === 1 ? 'model' : 'models'} · {enabledCount} enabled
        </p>
      </div>
      <ul className="divide-y divide-border/60 rounded-md border">
        {ordered.map((model) => {
          const isRecommended = recommendedModelIds.has(model.id);
          const busy = busyModelIds.has(model.id);
          return (
            <li
              className={cn('flex items-center gap-3 px-3 py-2', model.isEnabled && 'bg-primary/5')}
              key={model.id}
            >
              <Switch
                aria-busy={busy}
                aria-label={`Enable ${model.name}`}
                checked={model.isEnabled}
                data-testid={`provider-model-toggle-${model.id}`}
                disabled={busy}
                onCheckedChange={(checked) => onToggle(model.id, checked)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-sm">{model.name}</span>
                  <ModelTypeBadge model={model} />
                  {isRecommended ? (
                    <Badge
                      className="h-5 px-1.5 text-[10px]"
                      data-testid={`provider-model-recommended-${model.id}`}
                      variant="secondary"
                    >
                      Recommended
                    </Badge>
                  ) : null}
                </div>
                {model.tagline ? (
                  <p className="truncate text-muted-foreground text-xs">{model.tagline}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface ProviderModelCatalogLinkProps {
  readonly onNavigate: (() => void) | undefined;
}

/**
 * Downloads, cross-provider search and the local model cache stay in the Model
 * Catalog category — this surface owns connection and enablement only.
 */
export function ProviderModelCatalogLink({ onNavigate }: ProviderModelCatalogLinkProps) {
  if (!onNavigate) {
    return null;
  }
  return (
    <Button
      className="h-auto p-0 text-xs"
      data-testid="provider-model-catalog-link"
      onClick={onNavigate}
      variant="link"
    >
      Browse and download all models
    </Button>
  );
}
