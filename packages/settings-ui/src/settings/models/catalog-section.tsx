import {
  Badge,
  Button,
  cn,
  PROVIDER_COLOR_MAP,
  ProviderIcon,
  STICKY_SECTION_HEADER_LAYER_CLASS,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { ChevronRight } from 'lucide-react';
import { type CSSProperties, type RefObject, useCallback, useId, useMemo } from 'react';
import { buildSectionNodes, type CatalogNodeData, type CatalogRowNodes } from './catalog-nodes';
import type { CatalogRow } from './catalog-projection';
import type { CatalogSection as CatalogSectionModel } from './catalog-sections';

/** First-paint estimates only; TreeTable measures the real rows (TreeGrid row-height contract). */
const ROW_HEIGHT_ESTIMATES = { detail: 132, model: 36 };

/**
 * The sticky section header's painted height: MUST equal its literal `h-11`
 * class below (44px). TreeTable reserves it at the top of the shared scroller
 * so a keyboard-focused row is never brought into view underneath the header.
 */
const SECTION_HEADER_HEIGHT_PX = 44;

function rowClassName(node: TreeNode<CatalogNodeData>): string {
  if (node.data.kind === 'detail') {
    return 'cursor-default bg-muted/20 hover:bg-muted/20';
  }
  return node.data.row.enabled ? 'bg-primary/5' : '';
}

type ProviderTileStyle = CSSProperties & Record<'--provider-dark' | '--provider-light', string>;

function ProviderTile({ providerId }: { readonly providerId: string }) {
  const pair = PROVIDER_COLOR_MAP[providerId];
  const style: ProviderTileStyle | undefined = pair
    ? { '--provider-dark': pair.dark, '--provider-light': pair.light }
    : undefined;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md border bg-background',
        pair ? 'text-(--provider-light) dark:text-(--provider-dark)' : 'text-muted-foreground'
      )}
      style={style}
    >
      <ProviderIcon className="size-3.5" providerId={providerId} />
    </span>
  );
}

/** Decorative; the adjacent "n / total enabled" text carries the meaning. */
function EnabledMeter({ enabled, total }: { readonly enabled: number; readonly total: number }) {
  const percent = total === 0 ? 0 : Math.round((enabled / total) * 100);
  return (
    <span aria-hidden="true" className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
      <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
    </span>
  );
}

export interface CatalogSectionProps {
  readonly busyModelIds: ReadonlySet<string>;
  readonly columns: TreeTableColumn<CatalogNodeData>[];
  /** Narrow tier: drop the runtime tag and meter, keep counts and bulk actions. */
  readonly compact: boolean;
  readonly detailsOpenIds: ReadonlySet<string>;
  readonly expanded: boolean;
  readonly filtering: boolean;
  readonly getNodes: (row: CatalogRow) => CatalogRowNodes;
  readonly onBulkChange: (section: CatalogSectionModel, enabled: boolean) => void;
  readonly onToggleDetails: (modelId: string) => void;
  readonly onToggleModel: (modelId: string, enabled: boolean) => void;
  readonly onToggleSection: (providerId: string) => void;
  /** The catalog's single scroll owner (shared-scroller mode). */
  readonly scrollParentRef: RefObject<HTMLElement | null>;
  readonly section: CatalogSectionModel;
}

export function CatalogSection({
  busyModelIds,
  columns,
  compact,
  detailsOpenIds,
  expanded,
  filtering,
  getNodes,
  onBulkChange,
  onToggleDetails,
  onToggleModel,
  onToggleSection,
  scrollParentRef,
  section,
}: CatalogSectionProps) {
  const regionId = useId();
  const nodes = useMemo(() => buildSectionNodes(section.rows, getNodes), [getNodes, section.rows]);
  const rowsById = useMemo(() => new Map(section.rows.map((row) => [row.id, row])), [section.rows]);

  // Space on a focused row toggles its switch (the checkbox-list pattern);
  // Space on a details row is not consumed.
  const handleSpace = useCallback(
    (nodeId: string): boolean => {
      const row = rowsById.get(nodeId);
      if (!row) {
        return false;
      }
      if (!busyModelIds.has(row.id)) {
        onToggleModel(row.id, !row.enabled);
      }
      return true;
    },
    [busyModelIds, onToggleModel, rowsById]
  );

  // Enter (TreeTable "activate") toggles the details row.
  const handleActivate = useCallback(
    (nodeId: string | null): void => {
      if (nodeId !== null && rowsById.has(nodeId)) {
        onToggleDetails(nodeId);
      }
    },
    [onToggleDetails, rowsById]
  );

  const shown = section.rows.length;
  // The busy set is not reference-counted, so a bulk write overlapping an
  // in-flight toggle of a shown row could snapshot an uncommitted optimistic
  // state for Undo. Both bulk actions wait until the shown rows settle.
  const anyShownBusy = section.rows.some((row) => busyModelIds.has(row.id));
  const canEnable = !anyShownBusy && section.rows.some((row) => !row.enabled);
  const canDisable = !anyShownBusy && section.rows.some((row) => row.enabled);
  const { providerId } = section;

  return (
    <section
      className="border-b last:border-b-0"
      data-testid={`model-catalog-section-${providerId}`}
    >
      {/* h-11 is SECTION_HEADER_HEIGHT_PX; change both together. */}
      <div
        className={cn(
          'sticky top-0 flex h-11 items-center gap-3 border-b bg-card px-3',
          STICKY_SECTION_HEADER_LAYER_CLASS
        )}
        data-testid={`model-catalog-section-header-${providerId}`}
      >
        <h3 className="flex min-w-0">
          <button
            aria-controls={regionId}
            aria-expanded={expanded}
            className="flex min-w-0 max-w-full items-center gap-2 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            data-testid={`model-catalog-section-toggle-${providerId}`}
            onClick={() => onToggleSection(providerId)}
            type="button"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                expanded && 'rotate-90'
              )}
            />
            <ProviderTile providerId={providerId} />
            <span className="truncate font-semibold text-sm" title={section.providerName}>
              {section.providerName}
            </span>
            {!compact && section.runtimeLabel ? (
              <Badge
                className="h-5 shrink-0 px-1.5 font-medium text-[10px] uppercase tracking-wide"
                variant="outline"
              >
                {section.runtimeLabel}
              </Badge>
            ) : null}
          </button>
        </h3>
        {compact ? null : (
          <EnabledMeter enabled={section.enabledCount} total={section.totalCount} />
        )}
        <span
          className="shrink-0 text-muted-foreground text-xs tabular-nums"
          data-testid={`model-catalog-section-count-${providerId}`}
        >
          <span className="font-semibold text-foreground">{section.enabledCount}</span> /{' '}
          {section.totalCount} enabled
        </span>
        {filtering ? (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{shown} shown</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            data-testid={`model-catalog-enable-${providerId}`}
            disabled={!canEnable}
            onClick={() => onBulkChange(section, true)}
            size="xs"
            variant="ghost"
          >
            {filtering ? `Enable ${shown} shown` : 'Enable all'}
          </Button>
          <Button
            data-testid={`model-catalog-disable-${providerId}`}
            disabled={!canDisable}
            onClick={() => onBulkChange(section, false)}
            size="xs"
            variant="ghost"
          >
            {filtering ? `Disable ${shown} shown` : 'Disable all'}
          </Button>
        </div>
      </div>
      <div hidden={!expanded} id={regionId}>
        {expanded ? (
          <TreeTable
            ariaLabel={`${section.providerName} models`}
            columns={columns}
            expandedIds={detailsOpenIds}
            maxHeight="none"
            nodes={nodes}
            onCheckboxSpace={handleSpace}
            onSelect={handleActivate}
            onToggleExpand={onToggleDetails}
            overscan={8}
            rowClassName={rowClassName}
            rowHeight={ROW_HEIGHT_ESTIMATES}
            scrollPaddingStart={SECTION_HEADER_HEIGHT_PX}
            scrollParentRef={scrollParentRef}
            selectedId={null}
            selectionMode="single"
            selectOnRowClick={false}
            showHeader={false}
            windowingStrategy="virtual"
          />
        ) : null}
      </div>
    </section>
  );
}
