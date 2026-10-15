import { resolveReasoningControlsAvailability } from '@brainstrike/assistant-contract';
import type {
  AssistantProviderSettings,
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';
import {
  Button,
  createDraftFieldScope,
  type DraftFieldScope,
  DraftFieldScopeContext,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
} from '@brainstrike/ui';
import { defaultCollator } from '@brainstrike/utils/collator';
import { Info, RotateCw, Search, Settings2, SlidersHorizontal } from 'lucide-react';
import { useCallback, useId, useMemo, useState } from 'react';
import { DetailLevelControl } from './assistant-detail-control';
import type {
  AssistantToolMenuConfig,
  AssistantToolMenuItem,
  AssistantToolSource,
} from './assistant-ui-panel';
import { useOpenRouterModelMetadataLookup } from './openrouter-model-metadata-context';
import { ProviderSettingsPanel } from './provider-settings-panel';

interface ControlsMenuProps {
  modelName?: string | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  providerSettings?: AssistantProviderSettingsMap | undefined;
  selectedProvider?: string | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
}

interface ToolMenuGroup {
  id: string;
  items: AssistantToolMenuItem[];
  label: string;
  source: AssistantToolSource;
}

const ToolRow = ({
  canToggleTools,
  onToggleTool,
  tool,
}: {
  canToggleTools: boolean;
  onToggleTool: (toolId: string, enabled: boolean) => void;
  tool: AssistantToolMenuItem;
}) => {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();

  return (
    <div className="rounded-md hover:bg-accent/60">
      <div className="flex min-h-9 items-center gap-2 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-sm" title={tool.label}>
          {tool.label}
        </span>
        {tool.description && (
          <button
            aria-controls={helpOpen ? helpId : undefined}
            aria-expanded={helpOpen}
            aria-label={`About ${tool.label}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setHelpOpen((current) => !current)}
            type="button"
          >
            <Info aria-hidden className="size-3.5" />
          </button>
        )}
        <Switch
          aria-label={`${tool.label} enabled`}
          checked={tool.enabled}
          disabled={tool.disabled || !canToggleTools}
          onCheckedChange={(checked) => onToggleTool(tool.id, checked)}
        />
      </div>
      {tool.description && helpOpen && (
        <p
          className="wrap-break-word max-h-28 overflow-y-auto whitespace-pre-wrap border-t px-2 py-2 text-muted-foreground text-xs leading-relaxed"
          id={helpId}
        >
          {tool.description}
        </p>
      )}
    </div>
  );
};

const TOOL_SOURCE_ORDER: AssistantToolSource[] = ['native', 'mcp'];

/**
 * A popover dismissal the draft fields inside it must survive. Radix can
 * unmount content before the focused field blurs, so commit pending drafts at
 * the dismissal boundary. Escape still discards.
 */
function commitDraftsOrStayOpen(drafts: DraftFieldScope, event: Event): void {
  if (!drafts.commitAll()) {
    event.preventDefault();
  }
}

const OutputLimitsSection = ({
  drafts,
  hasOutputControls,
  modelName,
  onProviderSettingsChange,
  providerId,
  settings,
}: {
  drafts: DraftFieldScope;
  hasOutputControls: boolean;
  modelName: string | undefined;
  onProviderSettingsChange:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  providerId: string | undefined;
  settings: AssistantProviderSettings | undefined;
}) => {
  if (!hasOutputControls) {
    return null;
  }

  return (
    <details className="group rounded-lg border border-border/70 bg-muted/20">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is a native keyboard-operable disclosure; prevent closing over an invalid draft. */}
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-2.5 font-medium text-sm hover:bg-accent [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          const details = event.currentTarget.parentElement;
          if (details instanceof HTMLDetailsElement && details.open && !drafts.commitAll()) {
            event.preventDefault();
          }
        }}
      >
        <span>Output & Limits</span>
        <span
          aria-hidden
          className="text-muted-foreground transition-transform group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="border-t px-2 py-3">
        <DraftFieldScopeContext value={drafts}>
          <ProviderSettingsPanel
            modelName={modelName}
            onSettingsChange={onProviderSettingsChange}
            providerId={providerId}
            settings={settings}
          />
        </DraftFieldScopeContext>
      </div>
    </details>
  );
};

const ToolsControlsSection = ({
  canToggleTools,
  groupedTools,
  onOpenSettings,
  onToggleTool,
  toolMenu,
  toolSummary,
}: {
  canToggleTools: boolean;
  groupedTools: ToolMenuGroup[];
  onOpenSettings: () => void;
  onToggleTool: (toolId: string, enabled: boolean) => void;
  toolMenu: AssistantToolMenuConfig;
  toolSummary: string;
}) => {
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = groupedTools.flatMap((group) => {
    const visibleItems = group.items.filter((tool) =>
      [tool.label, tool.id, tool.description ?? '', group.label, group.source]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    );
    return visibleItems.length > 0 ? [{ ...group, visibleItems }] : [];
  });

  return (
    <section aria-label="AI Tools" className="space-y-2 border-t pt-3">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          AI Tools
        </h3>
        <span className="text-[11px] text-muted-foreground">{toolSummary}</span>
      </div>
      <div className="relative">
        <Search
          aria-hidden
          className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search tools"
          className="h-9 rounded-lg pl-9 text-sm"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tools…"
          type="search"
          value={query}
        />
      </div>
      {toolMenu.isLoading && (
        <div className="px-2 py-2 text-muted-foreground text-xs">Loading tools…</div>
      )}
      {!toolMenu.isLoading && groupedTools.length === 0 && (
        <div className="px-2 py-2 text-muted-foreground text-xs">No tools detected.</div>
      )}
      {!toolMenu.isLoading && groupedTools.length > 0 && visibleGroups.length === 0 && (
        <div className="px-2 py-3 text-muted-foreground text-sm">
          No tools match “{query.trim()}”.
        </div>
      )}
      {!toolMenu.isLoading &&
        visibleGroups.map((group) => {
          const enabledCount = group.items.filter((tool) => tool.enabled).length;
          return (
            <details
              className="group overflow-hidden rounded-lg border border-border/70"
              key={group.id}
              open={Boolean(normalizedQuery) || expandedGroups.has(group.id)}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is a native keyboard-operable disclosure; preserve expansion across search. */}
              <summary
                className="flex cursor-pointer list-none items-center gap-2 bg-muted/20 px-3 py-2 text-sm hover:bg-accent [&::-webkit-details-marker]:hidden"
                onClick={(event) => {
                  event.preventDefault();
                  if (normalizedQuery) {
                    return;
                  }
                  setExpandedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group.id)) {
                      next.delete(group.id);
                    } else {
                      next.add(group.id);
                    }
                    return next;
                  });
                }}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {enabledCount}/{group.items.length}
                </span>
                <span
                  aria-hidden
                  className="text-muted-foreground transition-transform group-open:rotate-90"
                >
                  ›
                </span>
              </summary>
              <div className="space-y-0.5 border-t p-1">
                {group.visibleItems.map((tool) => (
                  <ToolRow
                    canToggleTools={canToggleTools}
                    key={tool.id}
                    onToggleTool={onToggleTool}
                    tool={tool}
                  />
                ))}
              </div>
            </details>
          );
        })}
      {(toolMenu.onRefresh || toolMenu.onOpenSettings) && (
        <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
          {toolMenu.onRefresh && (
            <button
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
              onClick={() => void toolMenu.onRefresh?.()}
              type="button"
            >
              <RotateCw aria-hidden className="size-3.5" />
              Refresh tools
            </button>
          )}
          {toolMenu.onOpenSettings && (
            <button
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
              onClick={onOpenSettings}
              type="button"
            >
              <Settings2 aria-hidden className="size-3.5" />
              Manage tools…
            </button>
          )}
        </div>
      )}
    </section>
  );
};

export const ControlsMenu = ({
  toolMenu,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  modelName,
}: ControlsMenuProps) => {
  const openRouterMetadataLookup = useOpenRouterModelMetadataLookup();
  // Output & Limits renders for the hosted reasoning families. family:'local'
  // deliberately gets NO section here — its only reasoning control (the
  // Thinking toggle) lives in the composer model menu (pinned by the local
  // test below).
  const supportsOutputControls = useMemo(() => {
    if (!selectedProvider) {
      return false;
    }
    const availability = resolveReasoningControlsAvailability(
      selectedProvider,
      modelName,
      openRouterMetadataLookup?.state === 'resolved'
        ? openRouterMetadataLookup.snapshot.metadata
        : undefined
    );
    return availability.available;
  }, [modelName, openRouterMetadataLookup, selectedProvider]);

  const hasOutputControls = Boolean(supportsOutputControls && onProviderSettingsChange);

  const toolMenuItems = toolMenu?.items;
  const toolMenuSummary = toolMenu?.summary;

  const groupedTools = useMemo<ToolMenuGroup[]>(() => {
    if (!toolMenuItems) {
      return [];
    }

    const groups = new Map<string, ToolMenuGroup>();
    for (const item of toolMenuItems) {
      const key = `${item.source}::${item.group}`;
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(item);
        continue;
      }
      groups.set(key, {
        id: key,
        items: [item],
        label: item.group,
        source: item.source,
      });
    }

    return Array.from(groups.values()).sort((a, b) => {
      const sourceOrder = TOOL_SOURCE_ORDER.indexOf(a.source) - TOOL_SOURCE_ORDER.indexOf(b.source);
      if (sourceOrder !== 0) {
        return sourceOrder;
      }
      return defaultCollator.compare(a.label, b.label);
    });
  }, [toolMenuItems]);

  const toolSummary = useMemo(() => {
    if (!toolMenuItems) {
      return '';
    }
    const enabled = toolMenuItems.filter((tool) => tool.enabled).length;
    return toolMenuSummary ?? `${enabled} of ${toolMenuItems.length} enabled`;
  }, [toolMenuItems, toolMenuSummary]);

  const toolMenuOnToggleTool = toolMenu?.onToggleTool;

  const handleToggleTool = useCallback(
    (toolId: string, enabled: boolean) => {
      if (!toolMenuOnToggleTool) {
        return;
      }
      void toolMenuOnToggleTool(toolId, enabled);
    },
    [toolMenuOnToggleTool]
  );

  // The Detail control is always relevant, so the menu always renders even
  // without tools or reasoning settings.
  const activeSettings = selectedProvider ? providerSettings?.[selectedProvider] : undefined;
  const [drafts] = useState(createDraftFieldScope);
  const [open, setOpen] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!(nextOpen || drafts.commitAll())) {
      return;
    }
    setOpen(nextOpen);
  };

  const handleOpenSettings = () => {
    if (!drafts.commitAll()) {
      return;
    }
    setOpen(false);
    toolMenu?.onOpenSettings?.();
  };

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Open assistant controls"
          className="h-8 gap-1.5 rounded-full border-border/70 bg-background/85 px-3 text-xs"
          size="sm"
          variant="outline"
        >
          <SlidersHorizontal aria-hidden className="size-3.5 text-muted-foreground" />
          <span>Controls</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Assistant controls"
        className="max-h-[min(680px,80vh,var(--radix-popover-content-available-height))] w-[min(480px,calc(100vw-24px))] space-y-3 overflow-y-auto rounded-xl p-3"
        collisionPadding={12}
        // Pointer-down outside can unmount before a focused field blurs.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onInteractOutside={(event) => commitDraftsOrStayOpen(drafts, event)}
      >
        <div className="px-1">
          <h2 className="font-semibold text-sm">Assistant controls</h2>
          <p className="text-muted-foreground text-xs">
            Adjust what you see and which tools the assistant can use.
          </p>
        </div>
        <DetailLevelControl />
        <OutputLimitsSection
          drafts={drafts}
          hasOutputControls={hasOutputControls}
          modelName={modelName}
          onProviderSettingsChange={onProviderSettingsChange}
          providerId={selectedProvider}
          settings={activeSettings}
        />
        {toolMenu && (
          <ToolsControlsSection
            canToggleTools={Boolean(toolMenuOnToggleTool)}
            groupedTools={groupedTools}
            onOpenSettings={handleOpenSettings}
            onToggleTool={handleToggleTool}
            toolMenu={toolMenu}
            toolSummary={toolSummary}
          />
        )}
      </PopoverContent>
    </Popover>
  );
};
