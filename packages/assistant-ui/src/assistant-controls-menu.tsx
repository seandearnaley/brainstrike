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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Switch,
} from '@brainstrike/ui';
import { defaultCollator } from '@brainstrike/utils/collator';
import { SlidersHorizontal } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
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

const TOOL_SOURCE_ORDER: AssistantToolSource[] = ['native', 'mcp'];

/**
 * A menu dismissal the draft fields inside it must survive. Radix unmounts the
 * content on an outside pointer-down BEFORE a focused field blurs, so its
 * blur-commit never runs: the dismissal commits every pending draft itself,
 * and `preventDefault` (Radix's documented way to cancel a dismissal) keeps
 * the menu open while a refused draft shows its message. Escape still
 * discards: it is not an outside interaction.
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
    <>
      <DropdownMenuSeparator className="my-2" />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-sm">Output & Limits</DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className="w-[420px] p-2"
          // The submenu closes when focus leaves it (the pointer moves onto a
          // root item); cancelling that keeps a refused draft on screen.
          onFocusOutside={(event) => commitDraftsOrStayOpen(drafts, event)}
        >
          <DraftFieldScopeContext value={drafts}>
            <ProviderSettingsPanel
              modelName={modelName}
              onSettingsChange={onProviderSettingsChange}
              providerId={providerId}
              settings={settings}
            />
          </DraftFieldScopeContext>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
};

const ToolsControlsSection = ({
  groupedTools,
  hasTools,
  onToggleTool,
  toolMenu,
  toolSummary,
}: {
  groupedTools: ToolMenuGroup[];
  hasTools: boolean;
  onToggleTool: (toolId: string, enabled: boolean) => void;
  toolMenu: AssistantToolMenuConfig;
  toolSummary: string;
}) => {
  if (!hasTools) {
    return null;
  }

  return (
    <>
      <DropdownMenuSeparator className="my-2" />
      <DropdownMenuLabel className="px-1 text-[10px] text-muted-foreground uppercase tracking-wide">
        AI Tools
      </DropdownMenuLabel>
      {toolMenu.isLoading && (
        <div className="px-2 py-2 text-muted-foreground text-xs">Loading tools…</div>
      )}
      {!toolMenu.isLoading && groupedTools.length === 0 && (
        <div className="px-2 py-2 text-muted-foreground text-xs">No tools detected.</div>
      )}
      {!toolMenu.isLoading &&
        groupedTools.map((group) => {
          const enabledCount = group.items.filter((tool) => tool.enabled).length;
          return (
            <DropdownMenuSub key={group.id}>
              <DropdownMenuSubTrigger className="text-sm">
                <span className="flex-1 truncate">{group.label}</span>
                <span className="text-[10px] text-muted-foreground">
                  {enabledCount}/{group.items.length}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-[320px] p-1">
                {group.items.map((tool) => (
                  <DropdownMenuItem
                    className="flex items-start justify-between gap-3"
                    key={tool.id}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-sm">{tool.label}</p>
                      {tool.description && (
                        <p className="text-muted-foreground text-xs">{tool.description}</p>
                      )}
                    </div>
                    <Switch
                      checked={tool.enabled}
                      className="mt-0.5"
                      disabled={tool.disabled}
                      onCheckedChange={(checked) => onToggleTool(tool.id, checked)}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      {toolSummary && (
        <div className="px-2 pt-2 text-[10px] text-muted-foreground">{toolSummary}</div>
      )}
      {toolMenu.onRefresh && (
        <DropdownMenuItem
          className="mt-1"
          onSelect={(event) => {
            event.preventDefault();
            void toolMenu.onRefresh?.();
          }}
        >
          Refresh tools
        </DropdownMenuItem>
      )}
      {toolMenu.onOpenSettings && (
        <DropdownMenuItem onSelect={() => toolMenu.onOpenSettings?.()}>
          Manage tools…
        </DropdownMenuItem>
      )}
    </>
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
    return availability.available && availability.family !== 'local';
  }, [modelName, openRouterMetadataLookup, selectedProvider]);

  const hasOutputControls = Boolean(supportsOutputControls && onProviderSettingsChange);

  const toolMenuItems = toolMenu?.items;
  const toolMenuSummary = toolMenu?.summary;

  const hasTools = Boolean(toolMenuItems && toolMenuItems.length > 0);

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Open assistant controls"
          className="h-8 gap-1.5 rounded-full border-border/70 bg-background/85 px-3 text-xs"
          size="sm"
          variant="outline"
        >
          <SlidersHorizontal aria-hidden className="size-3.5 text-muted-foreground" />
          <span>Controls</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[340px] p-2"
        // A pointer-down outside (the trigger included) dismisses the whole
        // menu, submenu and all, before any field blurs.
        onInteractOutside={(event) => commitDraftsOrStayOpen(drafts, event)}
      >
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
            groupedTools={groupedTools}
            hasTools={hasTools}
            onToggleTool={handleToggleTool}
            toolMenu={toolMenu}
            toolSummary={toolSummary}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
