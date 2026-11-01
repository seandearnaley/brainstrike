import { Badge, Button, cn, formatTokenCount, Switch } from '@brainstrike/ui';
import { ChevronDown, Eye, Sun } from 'lucide-react';
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
export function Absent({ title }: { readonly title: string }) {
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
  const { query, showTagline } = useCatalogRowActions();
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
      <span className="truncate text-[13px] font-medium" title={row.id}>
        <HighlightedText query={query} text={row.name} />
      </span>
      {row.recommended ? (
        <Badge className="h-5 shrink-0 px-1.5 text-[10px]" variant="secondary">
          Recommended
        </Badge>
      ) : null}
      {secondary ? (
        <span
          className={cn('text-muted-foreground min-w-0 truncate text-xs', showId && 'font-mono')}
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

/**
 * One fixed capability slot. Vision and reasoning always occupy their own slot,
 * so a missing fact renders its own dash in place and never shifts its
 * neighbour's icon into the wrong column.
 */
function CapabilitySlot({
  icon,
  label,
  slot,
  state,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly slot: 'reasoning' | 'vision';
  readonly state: CapabilityState | null;
}) {
  if (state === null) {
    return (
      <span
        className="inline-flex size-5 items-center justify-center"
        data-capability-slot={slot}
        data-capability-state="absent"
      >
        <Absent title={`${label} not published`} />
      </span>
    );
  }
  const description = `${label} ${CAPABILITY_COPY[state]}`;
  return (
    <span
      aria-label={description}
      className={cn(
        'inline-flex size-5 items-center justify-center rounded',
        CAPABILITY_CLASS[state]
      )}
      data-capability-slot={slot}
      data-capability-state={state}
      role="img"
      title={description}
    >
      {icon}
    </span>
  );
}

export function CapabilitiesCell({ row }: { readonly row: CatalogRow }) {
  return (
    <div className={cn(ROW_LINE, 'gap-1.5')}>
      <CapabilitySlot
        icon={<Eye aria-hidden="true" className="size-3.5" />}
        label="Vision"
        slot="vision"
        state={row.vision}
      />
      <CapabilitySlot
        icon={<Sun aria-hidden="true" className="size-3.5" />}
        label="Reasoning"
        slot="reasoning"
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
