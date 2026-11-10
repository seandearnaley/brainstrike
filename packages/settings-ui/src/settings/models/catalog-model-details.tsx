import type { ModelModality, ModelSource } from '@brainstrike/assistant-contract/provider-registry';
import { Badge, CopyTextButton } from '@brainstrike/ui';
import { type ReactNode, useState } from 'react';
import { openExternalLink } from '../external-link';
import { Absent } from './catalog-cells';
import {
  formatCalendarDay,
  formatKnowledgeCutoff,
  formatPromptTokens,
  formatUsd,
} from './catalog-format';
import type {
  CatalogLifecycle,
  CatalogLongContextTier,
  CatalogPriceChange,
  CatalogPricing,
  CatalogRow,
} from './catalog-projection';

const fullNumber = new Intl.NumberFormat('en-US');

function Fact({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground text-2xs">{label}</dt>
      <dd className="text-xs">{children}</dd>
    </div>
  );
}

function Chips({ values }: { readonly values: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Badge className="text-2xs h-5 px-1.5 font-normal" key={value} variant="outline">
          {value}
        </Badge>
      ))}
    </div>
  );
}

function WindowFact({ row }: { readonly row: CatalogRow }) {
  const { contextWindow, maxOutputTokens } = row;
  if (contextWindow === null && maxOutputTokens === null) {
    return <Fact label="Context · Max output">Not published</Fact>;
  }
  return (
    <Fact label="Context · Max output">
      {contextWindow === null ? (
        <Absent title="Context window not published" />
      ) : (
        fullNumber.format(contextWindow)
      )}
      {' · '}
      {maxOutputTokens === null ? (
        <Absent title="Max output not published" />
      ) : (
        fullNumber.format(maxOutputTokens)
      )}
      {' tokens'}
    </Fact>
  );
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
  lines.push(...pricing.longContextTiers.map(longContextTierLine));
  if (pricing.nextChange !== null) {
    lines.push(scheduledChangeLine(pricing.nextChange));
  }
  return lines;
}

/** "From 272,000 prompt tokens: input $10 · output $45, cache read $1". */
function longContextTierLine(tier: CatalogLongContextTier): string {
  const cache = [
    tier.cacheReadPerMTok === null ? null : `cache read ${formatUsd(tier.cacheReadPerMTok)}`,
    tier.cacheWritePerMTok === null ? null : `cache write ${formatUsd(tier.cacheWritePerMTok)}`,
  ].filter((part) => part !== null);
  const rates = `input ${formatUsd(tier.inputPerMTok)} · output ${formatUsd(tier.outputPerMTok)}`;
  return `From ${formatPromptTokens(tier.minPromptTokens)} prompt tokens: ${[rates, ...cache].join(', ')}`;
}

/** "From 2026-12-01 (UTC): input $4 · output $20, cache read $0.20". */
function scheduledChangeLine(change: CatalogPriceChange): string {
  const cache = [
    change.cacheReadPerMTok === null ? null : `cache read ${formatUsd(change.cacheReadPerMTok)}`,
    change.cacheWritePerMTok === null ? null : `cache write ${formatUsd(change.cacheWritePerMTok)}`,
  ].filter((part) => part !== null);
  const rates = `input ${formatUsd(change.inputPerMTok)} · output ${formatUsd(change.outputPerMTok)}`;
  return `From ${change.effectiveFrom} (UTC): ${[rates, ...cache].join(', ')}`;
}

const LIFECYCLE_COPY = {
  active: 'Current',
  deprecated: 'Deprecated by the vendor',
  legacy: 'Superseded by a newer model',
  preview: 'Preview',
} as const satisfies Record<CatalogLifecycle['status'], string>;

/** "Superseded by a newer model · replaced by Claude Fable 5.2", plus the shutdown day. */
function lifecycleLines(lifecycle: CatalogLifecycle): string[] {
  const lines = [
    lifecycle.replacedBy === null
      ? LIFECYCLE_COPY[lifecycle.status]
      : `${LIFECYCLE_COPY[lifecycle.status]} · replaced by ${lifecycle.replacedBy}`,
  ];
  if (lifecycle.retiresAt !== null) {
    lines.push(`Retires ${formatCalendarDay(lifecycle.retiresAt)}`);
  }
  if (lifecycle.archived) {
    lines.push('Archived: hidden unless enabled or Show archived is on');
  }
  return lines;
}

function ReasoningFact({ row }: { readonly row: CatalogRow }) {
  if (row.reasoning === null) {
    return <Fact label="Reasoning effort">Not published</Fact>;
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

const MODALITY_LABELS = {
  audio: 'Audio',
  image: 'Image',
  pdf: 'PDF',
  text: 'Text',
  video: 'Video',
} as const satisfies Record<ModelModality, string>;

function ModalitiesFact({
  label,
  modalities,
}: {
  readonly label: string;
  readonly modalities: readonly ModelModality[] | null;
}) {
  return (
    <Fact label={label}>
      {modalities === null ? (
        'Not published'
      ) : (
        <Chips values={modalities.map((modality) => MODALITY_LABELS[modality])} />
      )}
    </Fact>
  );
}

/** A yes/no capability; `null` means no source says either way. */
function SupportFact({ label, value }: { readonly label: string; readonly value: boolean | null }) {
  let content = 'Not published';
  if (value !== null) {
    content = value ? 'Supported' : 'Not supported';
  }
  return <Fact label={label}>{content}</Fact>;
}

/** "github.com/sst/models.dev/blob/dev/models/openai/gpt-6-sol.toml": the URL without its scheme. */
function sourceLabel(url: string): string {
  return url.replace(/^https:\/\//u, '');
}

function Sources({ sources }: { readonly sources: readonly ModelSource[] }) {
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  if (sources.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-2xs">Sources</p>
      <ul className="space-y-0.5 text-xs">
        {sources.map((source) => (
          <li className="flex min-w-0 items-baseline gap-1" key={source.url}>
            <a
              className="text-primary truncate underline"
              href={source.url}
              onClick={(event) =>
                void openExternalLink(event, source.url).then((failure) => {
                  setLinkFailure(failure ?? null);
                })
              }
              rel="noreferrer"
              target="_blank"
              title={source.url}
            >
              {sourceLabel(source.url)}
            </a>
            <span className="text-muted-foreground shrink-0">
              · read {formatCalendarDay(source.retrievedAt)}
            </span>
          </li>
        ))}
      </ul>
      {linkFailure === null ? null : (
        <p className="text-destructive text-xs" role="alert">
          Couldn't open link: {linkFailure}
        </p>
      )}
    </div>
  );
}

/** The inline details row (a level-2 TreeTable row spanning every column). */
export function CatalogModelDetails({ row }: { readonly row: CatalogRow }) {
  return (
    <div className="space-y-3 py-3 pr-4 pl-[60px]" data-testid={`model-details-${row.id}`}>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-6 gap-y-3">
        <Fact label="Model ID">
          <span className="inline-flex max-w-full items-center gap-1">
            <code className="truncate font-mono text-xs">{row.id}</code>
            <CopyTextButton ariaLabel={`Copy model ID ${row.id}`} text={row.id} />
          </span>
        </Fact>
        <WindowFact row={row} />
        <Fact label="Pricing">
          {pricingLines(row.pricing).map((line) => (
            <span className="block" key={line}>
              {line}
            </span>
          ))}
        </Fact>
        <ReasoningFact row={row} />
        <ModalitiesFact label="Input" modalities={row.inputModalities} />
        <ModalitiesFact label="Output" modalities={row.outputModalities} />
        <SupportFact label="Tool calling" value={row.toolCalling} />
        <SupportFact label="Structured outputs" value={row.structuredOutputs} />
        <Fact label="Released">
          {row.lifecycle?.releasedAt
            ? formatCalendarDay(row.lifecycle.releasedAt)
            : 'Not published'}
        </Fact>
        <Fact label="Knowledge cutoff">
          {row.knowledgeCutoff === null
            ? 'Not published'
            : formatKnowledgeCutoff(row.knowledgeCutoff)}
        </Fact>
        {row.lifecycle === null || row.lifecycle.status === 'active' ? null : (
          <Fact label="Status">
            {lifecycleLines(row.lifecycle).map((line) => (
              <span className="block" key={line}>
                {line}
              </span>
            ))}
          </Fact>
        )}
        {row.bestFor.length > 0 ? (
          <Fact label="Best for">
            <Chips values={row.bestFor} />
          </Fact>
        ) : null}
      </dl>
      {row.description ? (
        <p className="text-muted-foreground max-w-prose text-xs leading-relaxed">
          {row.description}
        </p>
      ) : null}
      <Sources sources={row.sources} />
    </div>
  );
}
