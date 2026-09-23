import { Badge, Button, cn, formatTokenCount, Switch } from '@brainstrike/ui';
import { Check, ChevronDown, Download, Eye, Loader2, Sun } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { highlightSegments, queryHitsIdOnly } from './catalog-filters';
import { formatUsd } from './catalog-format';
import type { CatalogRow } from './catalog-projection';
import { useCatalogRowActions } from './use-catalog-row-actions';

/*
 * The Model Catalog's one-line cells. Component-only module (react-refresh);
 * `catalog-columns.tsx` maps each column id to one of these. Live row state
 * comes from `CatalogRowActionsContext`, never from props the columns close over.
 */

/**
 * One cell line. 35px of content plus the row's 1px collapsed border paints a
 * 36px pitch; Task 10's E2E measures it (docs/agents/ui-conventions.md, "Row
 * height and painted geometry"). If that measurement disagrees, fix THIS value.
 */
const ROW_LINE = 'flex h-[35px] items-center';

function HighlightedText({ query, text }: { readonly query: string; readonly text: string }) {
  return (
    <>
      {highlightSegments(text, query).map((segment) =>
        segment.match ? (
          <mark
            className="rounded-[2px] bg-yellow-300/60 text-inherit dark:bg-yellow-400/30"
            key={segment.start}
          >
            {segment.text}
          </mark>
        ) : (
          <Fragment key={segment.start}>{segment.text}</Fragment>
        )
      )}
    </>
  );
}

/** An unpublished fact: a visible dash, with the reason for screen readers and on hover. */
function Absent({ title }: { readonly title: string }) {
  return (
    <span className="text-muted-foreground text-xs" title={title}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

export function EnabledCell({ row }: { readonly row: CatalogRow }) {
  const { busyModelIds, onToggle } = useCatalogRowActions();
  const busy = busyModelIds.has(row.id);
  return (
    <div className={cn(ROW_LINE, 'justify-center')}>
      <Switch
        aria-busy={busy}
        aria-label={`Enable ${row.name}`}
        checked={row.enabled}
        data-testid={`model-toggle-${row.id}`}
        disabled={busy}
        onCheckedChange={(checked) => onToggle(row.id, checked)}
      />
    </div>
  );
}

export function ModelCell({ row }: { readonly row: CatalogRow }) {
  const { query, showTagline, showTypeTag } = useCatalogRowActions();
  const showId = queryHitsIdOnly(row, query);
  let secondary: string | null = null;
  if (showId) {
    secondary = row.id;
  } else if (showTagline) {
    secondary = row.tagline;
  }
  return (
    // `model-row-<id>` is kept for E2E continuity; TreeTable owns the <tr>.
    <div className={cn(ROW_LINE, 'min-w-0 gap-2')} data-testid={`model-row-${row.id}`}>
      <span className="truncate font-medium text-[13px]" title={row.id}>
        <HighlightedText query={query} text={row.name} />
      </span>
      {row.recommended ? (
        <Badge className="h-5 shrink-0 px-1.5 text-[10px]" variant="secondary">
          Recommended
        </Badge>
      ) : null}
      {showTypeTag && row.type === 'embedding' ? (
        <Badge className="h-5 shrink-0 px-1.5 text-[10px]" variant="outline">
          Embedding
        </Badge>
      ) : null}
      {secondary ? (
        <span
          className={cn('min-w-0 truncate text-muted-foreground text-xs', showId && 'font-mono')}
        >
          <HighlightedText query={query} text={secondary} />
        </span>
      ) : null}
    </div>
  );
}

type CapabilityState = 'supported' | 'unknown' | 'unsupported';

const CAPABILITY_COPY: Record<CapabilityState, string> = {
  supported: 'supported',
  unknown: 'unverified',
  unsupported: 'not supported',
};

const CAPABILITY_CLASS: Record<CapabilityState, string> = {
  supported: 'text-foreground',
  unknown: 'border border-muted-foreground/60 border-dashed text-muted-foreground',
  unsupported: 'text-muted-foreground/35',
};

function CapabilityIcon({
  icon,
  label,
  state,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly state: CapabilityState | null;
}) {
  if (state === null) {
    return null;
  }
  const description = `${label} ${CAPABILITY_COPY[state]}`;
  return (
    <span
      aria-label={description}
      className={cn(
        'inline-flex size-5 items-center justify-center rounded',
        CAPABILITY_CLASS[state]
      )}
      role="img"
      title={description}
    >
      {icon}
    </span>
  );
}

export function CapabilitiesCell({ row }: { readonly row: CatalogRow }) {
  if (row.type === 'embedding') {
    return (
      <div className={ROW_LINE}>
        {row.dimension === null ? (
          <Absent title="No published dimensions" />
        ) : (
          <span className="text-muted-foreground text-xs tabular-nums">
            <span aria-hidden="true">{row.dimension}-d</span>
            <span className="sr-only">{`${row.dimension}-dimension embeddings`}</span>
          </span>
        )}
      </div>
    );
  }
  if (row.vision === null && row.reasoning === null) {
    return (
      <div className={ROW_LINE}>
        <Absent title="No published capabilities" />
      </div>
    );
  }
  return (
    <div className={cn(ROW_LINE, 'gap-1.5')}>
      <CapabilityIcon
        icon={<Eye aria-hidden="true" className="size-3.5" />}
        label="Vision"
        state={row.vision}
      />
      <CapabilityIcon
        icon={<Sun aria-hidden="true" className="size-3.5" />}
        label="Reasoning"
        state={row.reasoning?.state ?? null}
      />
    </div>
  );
}

export function TokenCell({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number | null;
}) {
  return (
    <div className={cn(ROW_LINE, 'justify-end')}>
      {value === null ? (
        <Absent title={`No published ${label}`} />
      ) : (
        <span className="text-xs tabular-nums">
          <span aria-hidden="true">{formatTokenCount(value)}</span>
          <span className="sr-only">{`${value.toLocaleString('en-US')} token ${label}`}</span>
        </span>
      )}
    </div>
  );
}

export function PriceCell({ row }: { readonly row: CatalogRow }) {
  const { pricing } = row;
  if (!pricing) {
    return (
      <div className={cn(ROW_LINE, 'justify-end')}>
        <Absent title="No published price" />
      </div>
    );
  }
  if (pricing.inputPerMTok === 0 && pricing.outputPerMTok === 0) {
    return (
      <div className={cn(ROW_LINE, 'justify-end')}>
        <span className="text-xs">Free</span>
      </div>
    );
  }
  const input = formatUsd(pricing.inputPerMTok);
  const output = formatUsd(pricing.outputPerMTok);
  return (
    <div className={cn(ROW_LINE, 'justify-end')}>
      <span className="text-xs tabular-nums">
        <span aria-hidden="true">
          {input} <span className="text-muted-foreground">· {output}</span>
        </span>
        <span className="sr-only">{`input ${input}, output ${output} per million tokens`}</span>
      </span>
    </div>
  );
}

function DownloadControl({ row }: { readonly row: CatalogRow }) {
  const { downloadedModels, downloadProgress, isDownloading, onDownload } = useCatalogRowActions();
  if (isDownloading[row.id] === true) {
    const progress = downloadProgress[row.id];
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground text-xs tabular-nums">
        <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
        {progress === undefined ? 'Starting…' : `${progress}%`}
      </span>
    );
  }
  if (downloadedModels[row.id] === true) {
    return (
      <span
        aria-label={`${row.name} downloaded`}
        className="inline-flex items-center text-green-600 dark:text-green-400"
        role="img"
        title="Downloaded"
      >
        <Check aria-hidden="true" className="size-3.5" />
      </span>
    );
  }
  const label = row.sizeLabel ? `Download ${row.name} (${row.sizeLabel})` : `Download ${row.name}`;
  return (
    <Button
      aria-label={label}
      className="size-7"
      data-testid={`model-download-${row.id}`}
      onClick={() => onDownload(row.id)}
      size="icon-xs"
      title={label}
      variant="ghost"
    >
      <Download aria-hidden="true" className="size-3.5" />
    </Button>
  );
}

export function ActionsCell({
  isExpanded,
  row,
}: {
  readonly isExpanded: boolean;
  readonly row: CatalogRow;
}) {
  const { onToggleDetails } = useCatalogRowActions();
  return (
    <div className={cn(ROW_LINE, 'justify-end gap-1')}>
      {row.isLocal ? <DownloadControl row={row} /> : null}
      <Button
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${row.name}`}
        className="size-7"
        data-testid={`model-details-toggle-${row.id}`}
        onClick={() => onToggleDetails(row.id)}
        size="icon-xs"
        variant="ghost"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
            isExpanded && 'rotate-180'
          )}
        />
      </Button>
    </div>
  );
}
