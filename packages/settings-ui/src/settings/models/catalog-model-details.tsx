import { Badge, CopyTextButton } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { formatUsd } from './catalog-format';
import type { CatalogPricing, CatalogRow } from './catalog-projection';
import { useCatalogRowActions } from './use-catalog-row-actions';

const fullNumber = new Intl.NumberFormat('en-US');

function Fact({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-xs">{children}</dd>
    </div>
  );
}

function Chips({ values }: { readonly values: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Badge className="h-5 px-1.5 font-normal text-[10px]" key={value} variant="outline">
          {value}
        </Badge>
      ))}
    </div>
  );
}

function formatWindow(row: CatalogRow): string {
  if (row.contextWindow === null && row.maxOutputTokens === null) {
    return 'Not published';
  }
  const context = row.contextWindow === null ? '—' : fullNumber.format(row.contextWindow);
  const output = row.maxOutputTokens === null ? '—' : fullNumber.format(row.maxOutputTokens);
  return `${context} · ${output} tokens`;
}

function pricingLines(pricing: CatalogPricing | null): string[] {
  if (!pricing) {
    return ['No published price'];
  }
  const lines = [
    `Input ${formatUsd(pricing.inputPerMTok)} · Output ${formatUsd(pricing.outputPerMTok)} per 1M tokens`,
  ];
  if (pricing.cacheReadPerMTok !== null) {
    lines.push(`Cache read ${formatUsd(pricing.cacheReadPerMTok)}`);
  }
  if (pricing.cacheWritePerMTok !== null) {
    lines.push(`Cache write ${formatUsd(pricing.cacheWritePerMTok)}`);
  }
  return lines;
}

function ReasoningFact({ row }: { readonly row: CatalogRow }) {
  if (row.reasoning === null) {
    return null;
  }
  let content: ReactNode;
  switch (row.reasoning.state) {
    case 'supported':
      content =
        row.reasoningEfforts && row.reasoningEfforts.length > 0 ? (
          <Chips values={row.reasoningEfforts} />
        ) : (
          'Supported'
        );
      break;
    case 'unknown':
      content = 'Unverified';
      break;
    case 'unsupported':
      content = 'Not supported';
      break;
    default: {
      const exhaustive: never = row.reasoning;
      throw new Error(`Unknown reasoning support: ${JSON.stringify(exhaustive)}`);
    }
  }
  return <Fact label="Reasoning effort">{content}</Fact>;
}

function resolveCachePath(
  row: CatalogRow,
  downloaded: boolean,
  modelCacheDir: string | null
): string | null {
  if (!(row.isLocal && downloaded)) {
    return null;
  }
  return modelCacheDir ? `${modelCacheDir}/${row.id}` : 'Cached in system default';
}

/** The inline details row (a level-2 TreeTable row spanning every column). */
export function CatalogModelDetails({ row }: { readonly row: CatalogRow }) {
  const { downloadedModels, modelCacheDir } = useCatalogRowActions();
  const cachePath = resolveCachePath(row, downloadedModels[row.id] === true, modelCacheDir);
  return (
    <div className="space-y-3 py-3 pr-4 pl-[60px]" data-testid={`model-details-${row.id}`}>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-6 gap-y-3">
        <Fact label="Model ID">
          <span className="inline-flex max-w-full items-center gap-1">
            <code className="truncate font-mono text-xs">{row.id}</code>
            <CopyTextButton ariaLabel={`Copy model ID ${row.id}`} text={row.id} />
          </span>
        </Fact>
        {row.type === 'chat' ? (
          <Fact label="Context · Max output">{formatWindow(row)}</Fact>
        ) : (
          <Fact label="Dimensions">
            {row.dimension === null ? 'Not published' : fullNumber.format(row.dimension)}
          </Fact>
        )}
        <Fact label="Pricing">
          {pricingLines(row.pricing).map((line) => (
            <span className="block" key={line}>
              {line}
            </span>
          ))}
        </Fact>
        <ReasoningFact row={row} />
        {row.bestFor.length > 0 ? (
          <Fact label="Best for">
            <Chips values={row.bestFor} />
          </Fact>
        ) : null}
        {cachePath ? (
          <Fact label="Cache path">
            <code className="break-all font-mono text-[11px]">{cachePath}</code>
          </Fact>
        ) : null}
      </dl>
      {row.description ? (
        <p className="max-w-prose text-muted-foreground text-xs leading-relaxed">
          {row.description}
        </p>
      ) : null}
    </div>
  );
}
