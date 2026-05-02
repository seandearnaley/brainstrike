import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ChainOfThoughtPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  type ThreadHistoryAdapter,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
  useMessagePartReasoning,
} from '@assistant-ui/react';
import { useDataStreamRuntime } from '@assistant-ui/react-data-stream';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/agent/run-events';
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
  SlidersHorizontal,
  SquareIcon,
} from 'lucide-react';
import * as m from 'motion/react-m';
import { type FC, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
// @assistant-ui/styles v0.3.x consolidated all styles into index.css
import '@assistant-ui/styles/index.css';
import './overrides.css';
import { defaultCollator } from '@brainstrike/utils/collator';
import { Badge } from '../badge';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { Input } from '../input';
import { Label } from '../label';
import { cn } from '../lib/utils';
import { ModelPicker } from '../model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../model-picker/types';
import { Progress } from '../progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { Switch } from '../switch';
import { AssistantMessageText, preloadMarkdownText } from './assistant-message-text';
import { AssistantRunTimeline } from './assistant-run-timeline';
import {
  type BudgetStatus,
  clampNumber,
  clampProgress,
  getLocalModelStatusLabel,
  parseNumber,
  resolveBudgetStatus,
  truncateMiddle,
} from './assistant-ui-panel-utils';
import { createLocalModelAdapter, disposeLocalBackend } from './local-runtime-adapter';
import { ToolFallback } from './tool-fallback';
import { TooltipIconButton } from './tooltip-icon-button';

// Re-export types needed by consumers
export type { ModelPickerModel, ModelPickerProvider };

export interface ProviderConfig {
  defaultModel: string;
  id: string;
  models: readonly string[];
  name: string;
}

export type ProviderRuntimeCategory = 'hosted' | 'gateway' | 'local' | 'browser';

export interface ProviderModelOptionConfig {
  default?: boolean;
  enabled: boolean;
  id: string;
  label: string;
  supportsStandardDimension?: boolean;
  supportsStreaming?: boolean;
  type: 'llm' | 'embedding';
}

export interface ProviderOptionConfig {
  capabilities: {
    llm: boolean;
    embeddings: boolean;
    streaming: boolean;
    supportsStandardEmbeddingDimension: boolean;
  };
  id: string;
  models: ProviderModelOptionConfig[];
  name: string;
  runtime: ProviderRuntimeCategory;
}

export interface ProviderGroupConfig {
  label: string;
  providers: ProviderOptionConfig[];
  runtime: ProviderRuntimeCategory;
}

export type AssistantToolCategory =
  | 'retrieval'
  | 'action'
  | 'analysis'
  | 'configuration'
  | 'validation';

export type AssistantToolSource = 'native' | 'mcp';

export interface AssistantToolMenuItem {
  category?: AssistantToolCategory | string;
  description?: string;
  disabled?: boolean;
  enabled: boolean;
  group: string;
  id: string;
  inputSchema?: Record<string, unknown>;
  isLocalRuntimeRunnable?: boolean;
  label: string;
  source: AssistantToolSource;
}

export interface AssistantToolMenuConfig {
  isLoading?: boolean;
  items: AssistantToolMenuItem[];
  onOpenSettings?: () => void;
  onRefresh?: () => void;
  onToggleTool?: (toolId: string, enabled: boolean) => void | Promise<void>;
  summary?: string;
}

export interface AssistantContextMenuConfig {
  contextTokenCount?: number;
  embeddingSetId?: string;
  includeFileReport?: boolean;
  includeProjectTree?: boolean;
  onIncludeFileReportChange?: (value: boolean) => void;
  onIncludeProjectTreeChange?: (value: boolean) => void;
  onTokenBudgetChange?: (value: number) => void;
  selectionCount?: number;
  selectionLabel?: string;
  tokenBudget?: number;
}

// Provider-settings types live in `@brainstrike/types` so `packages/ui` and
// `packages/preferences` share a single canonical definition. They are
// re-exported here to keep the existing public surface of the
// `@brainstrike/ui/assistant-ui-panel` entry point stable for consumers that
// still import them from this module.
export type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  LocalRuntimeActivation,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
} from '@brainstrike/types';

import type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
} from '@brainstrike/types';

export interface AssistantUiPanelProps {
  className?: string;
  completePreparedRequest?: (
    requestData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void> | void;
  contextMenu?: AssistantContextMenuConfig;
  disabled?: boolean;
  disabledReason?: string;
  historyAdapter?: ThreadHistoryAdapter;
  onModelChange?: (compositeKey: string) => void;
  onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  onThreadRunStart?: () => void;
  /** Models for the ModelPicker component */
  pickerModels: ModelPickerModel[];
  /** Providers for the ModelPicker component */
  pickerProviders: ModelPickerProvider[];
  prepareRequestData?: () => Promise<Record<string, unknown> | undefined>;
  providerGroups?: ProviderGroupConfig[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  providers?: ProviderConfig[];
  requestData?: Record<string, unknown>;
  selectedModel?: string;
  selectedProvider?: string;
  threadKey?: string;
  toolMenu?: AssistantToolMenuConfig;
}

export type AssistantUiThreadHistoryAdapter = ThreadHistoryAdapter;

declare global {
  interface Window {
    assistant?: { getUrl?: () => Promise<string>; url?: string };
  }
}

// Local model loading state for progress display
interface LocalModelLoadingState {
  file?: string;
  message: string;
  progress: number;
  stage: 'downloading' | 'generating' | 'loading' | 'ready' | 'error';
}

const LocalModelStatus: FC<{ state: LocalModelLoadingState }> = ({ state }) => {
  const progress = clampProgress(state.progress);
  const showPercent = state.stage === 'downloading' && progress > 0;

  return (
    <div
      className={cn(
        'mx-3 mt-2 rounded-full border px-3 py-2',
        state.stage === 'error'
          ? 'border-destructive/40 bg-destructive/5'
          : 'border-border/70 bg-muted/30'
      )}
      data-testid="local-model-status"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge className="rounded-full px-2 py-0.5 text-[10px]" variant="secondary">
            Gemma
          </Badge>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-xs">{getLocalModelStatusLabel(state.stage)}</span>
              <span className="truncate text-muted-foreground text-xs">{state.message}</span>
            </div>
            {state.file && (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{state.file}</p>
            )}
          </div>
        </div>
        {showPercent && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {Math.round(progress)}%
          </span>
        )}
      </div>
      {state.stage === 'generating' || state.stage === 'loading' ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border/60">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground/45" />
        </div>
      ) : state.stage === 'downloading' ? (
        <Progress
          aria-label="Assistant loading progress"
          className="mt-2 h-1 bg-border/60"
          value={progress}
        />
      ) : null}
    </div>
  );
};

const LocalReasoningPart: FC = () => {
  useMessagePartReasoning();

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-3">
      <p className="mb-2 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
        Model reasoning
      </p>
      <div className="text-muted-foreground text-sm leading-6" data-testid="local-reasoning-part">
        <AssistantMessageText />
      </div>
    </div>
  );
};

const LocalChainOfThought: FC = () => {
  const aui = useAui();
  const collapsed = useAuiState((state) => state.chainOfThought.collapsed);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    aui.chainOfThought().setCollapsed(true);
  }, [aui]);

  return (
    <ChainOfThoughtPrimitive.Root className="mb-3 block max-w-xl">
      <button
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between rounded-2xl border border-border/70 bg-muted/25 px-3 py-2.5 text-left transition-colors hover:bg-muted/35"
        data-testid="local-chain-of-thought"
        onClick={() => aui.chainOfThought().setCollapsed(!collapsed)}
        type="button"
      >
        <div>
          <p className="font-medium text-foreground text-xs">Thinking</p>
          <p className="text-[11px] text-muted-foreground">
            {collapsed
              ? 'Reasoning and tool activity are hidden from the final reply.'
              : 'Inspect reasoning and tool activity before the final answer.'}
          </p>
        </div>
        <Badge className="rounded-full px-2 py-0.5 text-[10px]" variant="secondary">
          {collapsed ? 'Show reasoning' : 'Hide reasoning'}
        </Badge>
      </button>
      {!collapsed && (
        <div className="bs-chain-of-thought-panel mt-2">
          <ChainOfThoughtPrimitive.Parts
            components={{
              /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Layout" key */
              Layout: ({ children }) => <div className="mb-2 last:mb-0">{children}</div>,
              /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Reasoning" key */
              Reasoning: LocalReasoningPart,
              tools: {
                /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Fallback" key */
                Fallback: ToolFallback,
              },
            }}
          />
        </div>
      )}
    </ChainOfThoughtPrimitive.Root>
  );
};

// Keep this in sync with the collapsed-history nth-last-child selector in overrides.css.
const COLLAPSED_HISTORY_VISIBLE_MESSAGES = 8;

const ThreadHistoryControl: FC<{
  expanded: boolean;
  hiddenMessageCount: number;
  onExpandedChange: (expanded: boolean) => void;
}> = ({ expanded, hiddenMessageCount, onExpandedChange }) => {
  if (hiddenMessageCount <= 0) {
    return null;
  }

  return (
    <div aria-live="polite" className="bs-history-control" data-testid="assistant-history-control">
      <button
        aria-expanded={expanded}
        className="bs-history-control-button"
        data-testid="assistant-history-toggle"
        onClick={() => onExpandedChange(!expanded)}
        type="button"
      >
        {expanded ? (
          <ChevronUpIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )}
        <span>{hiddenMessageCount} previous messages</span>
      </button>
    </div>
  );
};

const ExpandableMessageContent: FC<{
  children: ReactNode;
  className: string;
  collapsedHeight?: number;
  testId?: string;
}> = ({ children, className, collapsedHeight = 176, testId }) => {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [contentHeight, setContentHeight] = useState(collapsedHeight);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) {
      return;
    }

    const measure = (): void => {
      const nextContentHeight = node.scrollHeight;
      setContentHeight(nextContentHeight);
      setHasOverflow(nextContentHeight > collapsedHeight + 1);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [collapsedHeight, children]);

  const collapsed = hasOverflow && !expanded;

  return (
    <div className={cn(className, 'bs-expandable-message')} data-testid={testId}>
      <m.div
        animate={{ maxHeight: collapsed ? collapsedHeight : contentHeight }}
        className="bs-expandable-message-body"
        initial={false}
        ref={contentRef}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        {children}
      </m.div>
      {collapsed ? <div aria-hidden="true" className="bs-expandable-message-fade" /> : null}
      {hasOverflow ? (
        <button
          aria-expanded={expanded}
          className="bs-expandable-message-toggle"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
};

// Shared props for inner chat components
interface ChatThreadProps {
  completePreparedRequest?:
    | ((
        requestData: Record<string, unknown> | undefined,
        status: 'cancelled' | 'completed' | 'failed',
        error?: string
      ) => Promise<void> | void)
    | undefined;
  contextMenu?: AssistantContextMenuConfig | undefined;
  disabled: boolean;
  disabledReason: string | undefined;
  localLoadingState?: LocalModelLoadingState | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  onThreadRunStart?: (() => void) | undefined;
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  prepareRequestData?: (() => Promise<Record<string, unknown> | undefined>) | undefined;
  providerGroups: ProviderGroupConfig[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  requestData?: Record<string, unknown> | undefined;
  selectedModel: string | undefined;
  selectedProvider: string | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
}

/**
 * Inner component for local runtime (browser-based inference).
 * Uses useLocalRuntime with LocalLlmBackend via transformers.js.
 */
const LocalRuntimeChat: FC<
  ChatThreadProps & {
    modelId: string;
    onLoadingStateChange: (state: LocalModelLoadingState) => void;
  }
> = ({
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  onThreadRunStart,
  disabled,
  disabledReason,
  localLoadingState,
  modelId,
  onLoadingStateChange,
  toolMenu,
  contextMenu,
  requestData,
  prepareRequestData,
  completePreparedRequest,
}) => {
  const hasGroupedProviders = providerGroups.length > 0;
  const isComposerDisabled = Boolean(disabled);
  const thinkingEnabled =
    providerSettings?.[selectedProvider ?? 'local']?.localThinkingEnabled ?? true;

  // Create adapter with memoization to avoid re-creating on every render
  const adapter = useMemo(
    () =>
      createLocalModelAdapter({
        modelId,
        thinkingEnabled,
        ...(requestData ? { runtimeData: requestData } : {}),
        prepareRuntimeData: async () => ({
          ...(requestData ?? {}),
          ...((await prepareRequestData?.()) ?? {}),
        }),
        ...(completePreparedRequest ? { completeRuntimeData: completePreparedRequest } : {}),
        ...(toolMenu?.items ? { tools: toolMenu.items } : {}),
        onLoadingProgress: (progress: LocalModelLoadingState) => {
          onLoadingStateChange(progress);
        },
        onError: (error: Error) => {
          onLoadingStateChange({
            stage: 'error',
            progress: 0,
            message: error.message,
          });
        },
      }),
    [
      completePreparedRequest,
      modelId,
      onLoadingStateChange,
      prepareRequestData,
      requestData,
      thinkingEnabled,
      toolMenu?.items,
    ]
  );

  const runtime = useLocalRuntime(adapter);

  // Cleanup on unmount
  useEffect(
    () => () => {
      void disposeLocalBackend();
    },
    []
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatThreadUI
        contextMenu={contextMenu}
        disabledReason={disabledReason}
        hasGroupedProviders={hasGroupedProviders}
        isComposerDisabled={isComposerDisabled}
        localLoadingState={localLoadingState}
        onModelChange={onModelChange}
        onProviderSettingsChange={onProviderSettingsChange}
        onThreadRunStart={onThreadRunStart}
        pickerModels={pickerModels}
        pickerProviders={pickerProviders}
        providerGroups={providerGroups}
        providerSettings={providerSettings}
        selectedModel={selectedModel}
        selectedProvider={selectedProvider}
        toolMenu={toolMenu}
      />
    </AssistantRuntimeProvider>
  );
};

/**
 * Inner component for data stream runtime (server-side hosted providers).
 * Uses useDataStreamRuntime for API-based inference.
 */
const DataStreamRuntimeChat: FC<
  ChatThreadProps & {
    api: string;
    completePreparedRequest?:
      | ((
          requestData: Record<string, unknown> | undefined,
          status: 'cancelled' | 'completed' | 'failed',
          error?: string
        ) => Promise<void> | void)
      | undefined;
    historyAdapter: ThreadHistoryAdapter | undefined;
    requestData: Record<string, unknown> | undefined;
    prepareRequestData?: (() => Promise<Record<string, unknown> | undefined>) | undefined;
    modelName: string | undefined;
  }
> = ({
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  onThreadRunStart,
  disabled,
  disabledReason,
  api,
  completePreparedRequest,
  historyAdapter,
  requestData,
  prepareRequestData,
  modelName,
  toolMenu,
  contextMenu,
}) => {
  const hasGroupedProviders = providerGroups.length > 0;
  const isComposerDisabled = Boolean(disabled);
  const preparedRequestRef = useRef<{ readonly data: Record<string, unknown> | undefined } | null>(
    null
  );
  const completePreparedRequestRef = useRef(completePreparedRequest);
  completePreparedRequestRef.current = completePreparedRequest;

  const completeLatestPreparedRequest = useCallback(
    async (status: 'cancelled' | 'completed' | 'failed', error?: string): Promise<void> => {
      const preparedRequest = preparedRequestRef.current;
      if (!preparedRequest) {
        return;
      }
      preparedRequestRef.current = null;
      await completePreparedRequestRef.current?.(preparedRequest.data, status, error);
    },
    []
  );

  const runtime = useDataStreamRuntime({
    api,
    protocol: 'data-stream',
    ...(historyAdapter ? { adapters: { history: historyAdapter } } : {}),
    body: async () => {
      if (preparedRequestRef.current) {
        throw new Error('Cannot start a hosted assistant run while another run is in progress.');
      }
      const preparedRequestData = prepareRequestData ? await prepareRequestData() : undefined;
      preparedRequestRef.current = { data: preparedRequestData };
      return {
        data: {
          ...(requestData ?? {}),
          ...(preparedRequestData ?? {}),
          provider: selectedProvider,
          model: modelName,
        },
      };
    },
    onCancel: () => {
      void completeLatestPreparedRequest('cancelled');
    },
    onError: (error: Error) => {
      void completeLatestPreparedRequest('failed', error.message);
    },
    onFinish: () => {
      void completeLatestPreparedRequest('completed');
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatThreadUI
        contextMenu={contextMenu}
        disabledReason={disabledReason}
        hasGroupedProviders={hasGroupedProviders}
        isComposerDisabled={isComposerDisabled}
        onModelChange={onModelChange}
        onProviderSettingsChange={onProviderSettingsChange}
        onThreadRunStart={onThreadRunStart}
        pickerModels={pickerModels}
        pickerProviders={pickerProviders}
        providerGroups={providerGroups}
        providerSettings={providerSettings}
        selectedModel={selectedModel}
        selectedProvider={selectedProvider}
        toolMenu={toolMenu}
      />
    </AssistantRuntimeProvider>
  );
};

/**
 * Shared UI component for the chat thread.
 * Extracted to avoid duplication between local and data stream runtimes.
 */
const ChatThreadUI: FC<{
  providerGroups: ProviderGroupConfig[];
  hasGroupedProviders: boolean;
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  selectedProvider: string | undefined;
  selectedModel: string | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  onThreadRunStart?: (() => void) | undefined;
  isComposerDisabled: boolean;
  disabledReason: string | undefined;
  localLoadingState?: LocalModelLoadingState | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
  contextMenu?: AssistantContextMenuConfig | undefined;
}> = ({
  providerGroups,
  hasGroupedProviders,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  onThreadRunStart,
  isComposerDisabled,
  disabledReason,
  localLoadingState,
  toolMenu,
  contextMenu,
}) => {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const messageCount = useAuiState((state) => state.thread.messages.length);
  const hiddenMessageCount = Math.max(0, messageCount - COLLAPSED_HISTORY_VISIBLE_MESSAGES);
  const historyCollapsed = hiddenMessageCount > 0 && !historyExpanded;

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bs-thread flex h-full min-h-0 flex-col"
      data-history-collapsed={historyCollapsed ? 'true' : undefined}
    >
      {/**
       * Messages Viewport
       *
       * CRITICAL: className only includes "aui-thread-viewport" - NO additional Tailwind classes
       *
       * WHY: The @assistant-ui library applies its own classes via @apply in CSS.
       * Adding Tailwind classes here (flex-1, overflow-y-auto, etc.) creates conflicts.
       *
       * All layout constraints are handled in overrides.css with !important declarations
       * to override the library's defaults.
       *
       * See: packages/ui/src/assistant-ui-panel/overrides.css
       * Post-mortem: apps/docs/docs/archive/cold/handoffs/20250930-094210-assistant-ui-layout-fix-postmortem.md
       */}
      <ThreadPrimitive.Viewport
        aria-atomic="false"
        aria-live="polite"
        autoScroll
        className="aui-thread-viewport"
        data-testid="assistant-ui-viewport"
        scrollToBottomOnInitialize={false}
        scrollToBottomOnRunStart={false}
      >
        {disabledReason && (
          <p aria-live="polite" className="px-4 py-3 text-muted-foreground text-xs">
            {disabledReason}
          </p>
        )}
        <ThreadHistoryControl
          expanded={historyExpanded}
          hiddenMessageCount={hiddenMessageCount}
          onExpandedChange={setHistoryExpanded}
        />
        <ThreadPrimitive.Messages
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
            AssistantMessage,
            /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
            UserMessage,
            /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
            EditComposer,
          }}
        />
      </ThreadPrimitive.Viewport>

      {/**
       * Composer: Fixed at bottom of thread
       *
       * STRUCTURE: This is a SIBLING to the viewport, not a child
       *
       * LAYOUT:
       * - flex-shrink-0: Never shrinks, always maintains its height
       * - Viewport above is flex-1: Grows/shrinks to fill available space
       * - This pattern ensures composer stays at bottom regardless of message content
       *
       * LIBRARY DIFFERENCE:
       * The @assistant-ui library expects the composer INSIDE the viewport as:
       *   <ThreadPrimitive.Viewport>
       *     <Messages />
       *     <div className="aui-thread-viewport-footer" style="position: sticky">
       *       <Composer />
       *     </div>
       *   </ThreadPrimitive.Viewport>
       *
       * We extracted it outside to avoid scrolling with messages.
       * This required aggressive CSS overrides (see overrides.css).
       */}
      <div className="bs-composer-shell" data-testid="assistant-composer-shell">
        {localLoadingState && <LocalModelStatus state={localLoadingState} />}
        <ComposerPrimitive.Root
          aria-disabled={isComposerDisabled}
          className="aui-composer-root"
          data-disabled={isComposerDisabled ? '' : undefined}
          onSubmitCapture={onThreadRunStart}
        >
          <div className="bs-composer-input-frame">
            <ComposerPrimitive.Input
              aria-label="Message input"
              className="aui-composer-input"
              disabled={isComposerDisabled}
              id="assistant-input"
              placeholder="Ask BrainStrike anything..."
              rows={1}
            />
            <div className="bs-composer-primary-actions">
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send
                  aria-label="Send"
                  className="aui-button aui-button-primary aui-composer-send"
                  disabled={isComposerDisabled}
                  title="Send"
                >
                  <ArrowUpIcon className="size-4" />
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                <ComposerPrimitive.Cancel
                  aria-label="Stop"
                  className="aui-button aui-button-primary aui-composer-cancel"
                  disabled={isComposerDisabled}
                  title="Stop"
                >
                  <SquareIcon className="size-3.5 fill-current" />
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </div>
          </div>
          {hasGroupedProviders && (
            <ProviderModelHeader
              contextMenu={contextMenu}
              groups={providerGroups}
              onModelChange={onModelChange}
              onProviderSettingsChange={onProviderSettingsChange}
              pickerModels={pickerModels}
              pickerProviders={pickerProviders}
              providerSettings={providerSettings}
              selectedModel={selectedModel}
              selectedProvider={selectedProvider}
              toolMenu={toolMenu}
            />
          )}
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
};

// Pure UI layer: state management and data wiring live in app-shell wrapper(s).
export const AssistantUiPanel: FC<AssistantUiPanelProps> = ({
  className,
  completePreparedRequest,
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  requestData,
  prepareRequestData,
  onModelChange,
  onThreadRunStart,
  toolMenu,
  contextMenu,
  disabled = false,
  disabledReason,
  historyAdapter,
  threadKey,
}) => {
  // API URL for data stream runtime (hosted providers)
  const initialApi =
    typeof window === 'undefined'
      ? '/api/assistant'
      : window.assistant?.url
        ? `${window.assistant.url}/assistant`
        : '/api/assistant';
  const [api, setApi] = useState<string>(initialApi);

  // Local model loading state
  const [localLoadingState, setLocalLoadingState] = useState<LocalModelLoadingState | undefined>();

  useEffect(() => {
    void preloadMarkdownText();

    const getUrl = window.assistant?.getUrl;
    if (!getUrl) {
      return;
    }
    const updateApi = async () => {
      try {
        const url = await getUrl();
        if (url) {
          setApi(`${url}/assistant`);
        }
      } catch {
        // Ignore errors from getUrl
      }
    };

    void updateApi();
  }, []);

  const groupedProviders = providerGroups ?? [];

  // Extract model name from composite key (format: "provider::model")
  const modelName = useMemo(() => {
    if (!selectedModel) {
      return;
    }
    const parts = selectedModel.split('::');
    return parts.length === 2 ? parts[1] : selectedModel;
  }, [selectedModel]);

  // Check if using local provider
  const isLocalProvider = selectedProvider === 'local';

  // Handler for local model loading state updates
  const handleLocalLoadingStateChange = useCallback((state: LocalModelLoadingState) => {
    setLocalLoadingState(state);
  }, []);

  useEffect(() => {
    if (localLoadingState?.stage !== 'ready') {
      return;
    }

    const timer = window.setTimeout(() => {
      setLocalLoadingState((current) => (current?.stage === 'ready' ? undefined : current));
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [localLoadingState]);

  return (
    <section
      aria-label="Assistant chat"
      className={cn('assistant-ui-panel flex h-full min-h-0 flex-col', className)}
      data-testid="chat-panel"
    >
      {isLocalProvider && modelName ? (
        <LocalRuntimeChat
          completePreparedRequest={completePreparedRequest}
          contextMenu={contextMenu}
          disabled={disabled}
          disabledReason={disabledReason}
          key={threadKey ? `local:${threadKey}` : 'local'}
          localLoadingState={localLoadingState}
          modelId={modelName}
          onLoadingStateChange={handleLocalLoadingStateChange}
          onModelChange={onModelChange}
          onProviderSettingsChange={onProviderSettingsChange}
          onThreadRunStart={onThreadRunStart}
          pickerModels={pickerModels}
          pickerProviders={pickerProviders}
          prepareRequestData={prepareRequestData}
          providerGroups={groupedProviders}
          providerSettings={providerSettings}
          requestData={requestData}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          toolMenu={toolMenu}
        />
      ) : (
        <DataStreamRuntimeChat
          api={api}
          completePreparedRequest={completePreparedRequest}
          contextMenu={contextMenu}
          disabled={disabled}
          disabledReason={disabledReason}
          historyAdapter={historyAdapter}
          key={threadKey ? `data-stream:${threadKey}` : 'data-stream'}
          modelName={modelName}
          onModelChange={onModelChange}
          onProviderSettingsChange={onProviderSettingsChange}
          onThreadRunStart={onThreadRunStart}
          pickerModels={pickerModels}
          pickerProviders={pickerProviders}
          prepareRequestData={prepareRequestData}
          providerGroups={groupedProviders}
          providerSettings={providerSettings}
          requestData={requestData}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          toolMenu={toolMenu}
        />
      )}
    </section>
  );
};

// ===== Message Components =====

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-user-message-root grid w-full auto-rows-auto grid-cols-[minmax(48px,1fr)_auto] gap-y-2 py-3 [&:where(>*)]:col-start-2">
      <UserActionBar />

      <ExpandableMessageContent
        className="aui-user-message-content col-start-2 row-start-2 max-w-xl break-words rounded-2xl bg-muted px-4 py-2"
        testId="assistant-user-message-content"
      >
        <MessagePrimitive.Parts
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
            Text: AssistantMessageText,
          }}
        />
      </ExpandableMessageContent>

      <BranchPicker className="col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    className="col-start-1 row-start-2 mt-2 mr-3 flex flex-col items-end"
    hideWhenRunning
  >
    <ActionBarPrimitive.Edit asChild>
      <TooltipIconButton aria-label="Edit message" tooltip="Edit">
        <PencilIcon className="size-4" />
      </TooltipIconButton>
    </ActionBarPrimitive.Edit>
  </ActionBarPrimitive.Root>
);

const EditComposer: FC = () => (
  <ComposerPrimitive.Root className="my-4 flex w-full flex-col gap-2 rounded-xl bg-muted">
    <ComposerPrimitive.Input className="flex h-8 w-full resize-none bg-transparent p-4 pb-0 text-foreground outline-none" />

    <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
      <ComposerPrimitive.Cancel asChild>
        <Button size="sm" variant="ghost">
          Cancel
        </Button>
      </ComposerPrimitive.Cancel>
      <ComposerPrimitive.Send asChild>
        <Button size="sm">Send</Button>
      </ComposerPrimitive.Send>
    </div>
  </ComposerPrimitive.Root>
);

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-assistant-message-root relative grid w-full grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-4">
      <div className="aui-assistant-message-content col-span-2 col-start-2 row-start-1 my-1.5 max-w-2xl break-words text-foreground leading-7">
        <MessagePrimitive.Parts
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "ChainOfThought" key */
            ChainOfThought: LocalChainOfThought,
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
            Text: AssistantMessageText,
            data: {
              /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "by_name" key */
              by_name: {
                [ASSISTANT_RUN_EVENT_DATA_NAME]: AssistantRunTimeline,
              },
            },
          }}
        />
      </div>

      <AssistantActionBar />

      <BranchPicker className="col-start-2 row-start-2 mr-2 -ml-2" />
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    autohideFloat="single-branch"
    className="col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:bg-background data-[floating]:p-1 data-[floating]:shadow-sm"
    hideWhenRunning
  >
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton aria-label="Copy message" tooltip="Copy">
        <MessagePrimitive.If copied>
          <CheckIcon className="size-4" />
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <CopyIcon className="size-4" />
        </MessagePrimitive.If>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton aria-label="Regenerate response" tooltip="Retry">
        <RefreshCwIcon className="size-4" />
      </TooltipIconButton>
    </ActionBarPrimitive.Reload>
  </ActionBarPrimitive.Root>
);

const BranchPicker: FC<{ className?: string }> = ({ className }) => (
  <BranchPickerPrimitive.Root
    className={`inline-flex items-center text-muted-foreground text-xs ${className ?? ''}`}
    hideWhenSingleBranch
  >
    <BranchPickerPrimitive.Previous asChild>
      <TooltipIconButton aria-label="Previous branch" tooltip="Previous">
        <ChevronLeftIcon className="size-4" />
      </TooltipIconButton>
    </BranchPickerPrimitive.Previous>
    <span className="font-medium">
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
    </span>
    <BranchPickerPrimitive.Next asChild>
      <TooltipIconButton aria-label="Next branch" tooltip="Next">
        <ChevronRightIcon className="size-4" />
      </TooltipIconButton>
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);

const RUNTIME_LABELS: Record<ProviderRuntimeCategory, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

interface ProviderModelOption {
  groupLabel: string;
  model: ProviderModelOptionConfig;
  provider: ProviderOptionConfig;
  value: string;
}

interface NormalizedProviderGroup {
  label: string;
  providers: Array<{
    provider: ProviderOptionConfig;
    models: ProviderModelOptionConfig[];
  }>;
  runtime: ProviderRuntimeCategory;
}

interface ProviderModelHeaderProps {
  contextMenu?: AssistantContextMenuConfig | undefined;
  groups: ProviderGroupConfig[];
  onModelChange?: ((compositeKey: string) => void) | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  selectedModel?: string | undefined;
  selectedProvider?: string | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
}

const ProviderModelHeader: FC<ProviderModelHeaderProps> = ({
  groups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  toolMenu,
  contextMenu,
}) => {
  // Extract model name from composite key (format: "provider::model")
  const modelName = useMemo(() => {
    if (!selectedModel) {
      return;
    }
    const parts = selectedModel.split('::');
    return parts.length === 2 ? parts[1] : selectedModel;
  }, [selectedModel]);

  const normalizedGroups = useMemo<NormalizedProviderGroup[]>(
    () =>
      groups
        .map((group) => {
          const providers = group.providers
            .map((provider) => ({
              provider,
              models: provider.models.filter((model) => model.enabled),
            }))
            .filter((entry) => entry.models.length > 0);
          if (providers.length === 0) {
            return null;
          }
          return {
            runtime: group.runtime,
            label: group.label ?? RUNTIME_LABELS[group.runtime],
            providers,
          };
        })
        .filter((group): group is NormalizedProviderGroup => group !== null),
    [groups]
  );

  const options = useMemo<ProviderModelOption[]>(
    () =>
      normalizedGroups.flatMap((group) =>
        group.providers.flatMap((entry) =>
          entry.models.map((model) => ({
            value: `${entry.provider.id}::${model.id}`,
            provider: entry.provider,
            model,
            groupLabel: group.label,
          }))
        )
      ),
    [normalizedGroups]
  );

  // Build a lookup map from model ID to provider ID for the ModelPicker callback
  const modelToProviderMap = useMemo(() => {
    const map = new Map<string, string>();
    if (pickerModels) {
      for (const model of pickerModels) {
        map.set(model.id, model.providerId);
      }
    }
    return map;
  }, [pickerModels]);

  // Handle ModelPicker selection - convert model ID to composite key
  const handleModelPickerChange = useCallback(
    (modelId: string | string[]) => {
      const id = Array.isArray(modelId) ? modelId[0] : modelId;
      if (!id) {
        return;
      }

      const providerId = modelToProviderMap.get(id);
      if (providerId) {
        // Construct composite key: "provider::model"
        onModelChange?.(`${providerId}::${id}`);
      }
    },
    [modelToProviderMap, onModelChange]
  );

  return (
    <div className="bs-composer-control-dock" data-testid="assistant-composer-controls">
      <div className="bs-composer-primary-controls">
        <div className="bs-composer-model-slot" data-testid="assistant-model-dropdown">
          <ModelPicker
            models={pickerModels}
            providers={pickerProviders}
            {...(modelName ? { value: modelName } : {})}
            className="bs-composer-model-picker h-8 rounded-full border-border/70 bg-background/85 text-xs"
            disabled={options.length === 0 || !onModelChange}
            mode="single"
            modelType="llm"
            onChange={handleModelPickerChange}
            placeholder={options.length === 0 ? 'No models enabled' : 'Select a model...'}
          />
        </div>
        <div className="bs-composer-controls-slot">
          <ControlsMenu
            contextMenu={contextMenu}
            modelName={modelName}
            onProviderSettingsChange={onProviderSettingsChange}
            providerSettings={providerSettings}
            selectedProvider={selectedProvider}
            toolMenu={toolMenu}
          />
        </div>
      </div>
      <div className="bs-composer-context-slot">
        <ContextSummaryRow contextMenu={contextMenu} />
      </div>
    </div>
  );
};

interface ControlsMenuProps {
  contextMenu?: AssistantContextMenuConfig | undefined;
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

const ContextControlsSection: FC<{
  contextMenu: AssistantContextMenuConfig;
  budgetStatus: BudgetStatus | undefined;
}> = ({ contextMenu, budgetStatus }) => (
  <div className="space-y-2">
    <DropdownMenuLabel className="px-1 text-[10px] text-muted-foreground uppercase tracking-wide">
      Context
    </DropdownMenuLabel>
    <div className="space-y-2 rounded-md border border-border/70 bg-background/80 p-2 text-xs">
      <div className="grid grid-cols-[120px_1fr] items-center gap-2">
        <span className="text-muted-foreground">Selection</span>
        <span className="font-medium">
          {contextMenu.selectionLabel ??
            (contextMenu.selectionCount ? `${contextMenu.selectionCount} files` : 'None')}
        </span>
      </div>
      {contextMenu.embeddingSetId && (
        <div className="grid grid-cols-[120px_1fr] items-center gap-2">
          <span className="text-muted-foreground">Embedding set</span>
          <span className="font-medium">{truncateMiddle(contextMenu.embeddingSetId, 10, 6)}</span>
        </div>
      )}
      <div className="grid grid-cols-[120px_1fr] items-center gap-2">
        <span className="text-muted-foreground">Include file report</span>
        <div className="flex justify-end">
          <Switch
            checked={contextMenu.includeFileReport ?? true}
            onCheckedChange={(checked) => contextMenu.onIncludeFileReportChange?.(checked)}
          />
        </div>
      </div>
      <div className="grid grid-cols-[120px_1fr] items-center gap-2">
        <span className="text-muted-foreground">Include file tree</span>
        <div className="flex justify-end">
          <Switch
            checked={contextMenu.includeProjectTree ?? false}
            onCheckedChange={(checked) => contextMenu.onIncludeProjectTreeChange?.(checked)}
          />
        </div>
      </div>
      {typeof contextMenu.tokenBudget === 'number' && (
        <div className="grid grid-cols-[120px_1fr] items-center gap-2">
          <Label className="text-muted-foreground">Token budget</Label>
          <div className="flex items-center gap-2">
            <Input
              className="h-7 text-xs"
              disabled={!contextMenu.onTokenBudgetChange}
              inputMode="numeric"
              onChange={(event) => {
                if (!contextMenu.onTokenBudgetChange) {
                  return;
                }
                const parsed = parseNumber(event.target.value);
                if (parsed === undefined) {
                  return;
                }
                contextMenu.onTokenBudgetChange(parsed);
              }}
              type="number"
              value={contextMenu.tokenBudget}
            />
            <span className="text-[10px] text-muted-foreground">
              {settingsNumberFormatter.format(contextMenu.tokenBudget)}
            </span>
          </div>
        </div>
      )}
      {typeof contextMenu.contextTokenCount === 'number' && (
        <div className="grid grid-cols-[120px_1fr] items-center gap-2">
          <span className="text-muted-foreground">Est. context tokens</span>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {settingsNumberFormatter.format(contextMenu.contextTokenCount)} tokens
            </span>
            {budgetStatus && (
              <Badge
                variant={
                  budgetStatus === 'over'
                    ? 'destructive'
                    : budgetStatus === 'near'
                      ? 'secondary'
                      : 'outline'
                }
              >
                {budgetStatus === 'over'
                  ? 'Over budget'
                  : budgetStatus === 'near'
                    ? 'Near budget'
                    : 'Within budget'}
              </Badge>
            )}
          </div>
        </div>
      )}
    </div>
  </div>
);

const ReasoningControlsSection: FC<{
  hasReasoning: boolean;
  modelName: string | undefined;
  onProviderSettingsChange:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  providerId: string | undefined;
  settings: AssistantProviderSettings | undefined;
}> = ({ hasReasoning, modelName, onProviderSettingsChange, providerId, settings }) => {
  if (!hasReasoning) {
    return null;
  }

  return (
    <>
      <DropdownMenuSeparator className="my-2" />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-sm">Reasoning & Output</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-[420px] p-2">
          <ProviderSettingsPanel
            modelName={modelName}
            onSettingsChange={onProviderSettingsChange}
            providerId={providerId}
            settings={settings}
          />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
};

const ToolsControlsSection: FC<{
  groupedTools: ToolMenuGroup[];
  hasTools: boolean;
  onToggleTool: (toolId: string, enabled: boolean) => void;
  toolMenu: AssistantToolMenuConfig;
  toolSummary: string;
}> = ({ groupedTools, hasTools, onToggleTool, toolMenu, toolSummary }) => {
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

const ControlsMenu: FC<ControlsMenuProps> = ({
  contextMenu,
  toolMenu,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  modelName,
}) => {
  const supportsReasoningSettings = useMemo(() => {
    if (!selectedProvider) {
      return false;
    }
    const normalized = selectedProvider.toLowerCase();
    return (
      normalized === 'openai' ||
      normalized === 'openrouter' ||
      normalized === 'anthropic' ||
      normalized === 'google'
    );
  }, [selectedProvider]);

  const hasContext = Boolean(contextMenu);
  const hasReasoning = Boolean(supportsReasoningSettings && onProviderSettingsChange);

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
        label: item.group,
        source: item.source,
        items: [item],
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

  if (!(hasContext || hasTools || hasReasoning)) {
    return null;
  }

  const activeSettings = selectedProvider ? providerSettings?.[selectedProvider] : undefined;
  const budgetStatus = resolveBudgetStatus(contextMenu);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Open assistant controls"
          className="h-9 gap-2 rounded-full border-border/70 px-3 text-xs"
          size="sm"
          variant="outline"
        >
          <SlidersHorizontal className="h-4 w-4" />
          <span>Controls</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[340px] p-2">
        {hasContext && contextMenu && (
          <ContextControlsSection budgetStatus={budgetStatus} contextMenu={contextMenu} />
        )}
        <ReasoningControlsSection
          hasReasoning={hasReasoning}
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

const ContextSummaryRow: FC<{ contextMenu?: AssistantContextMenuConfig | undefined }> = ({
  contextMenu,
}) => {
  if (!contextMenu) {
    return null;
  }

  const badges: Array<{ key: string; label: string }> = [];
  if (contextMenu.selectionLabel) {
    badges.push({ key: 'selection', label: contextMenu.selectionLabel });
  } else if (contextMenu.selectionCount) {
    badges.push({ key: 'selection', label: `${contextMenu.selectionCount} files` });
  }
  if (contextMenu.embeddingSetId) {
    badges.push({
      key: 'embedding',
      label: `Set ${truncateMiddle(contextMenu.embeddingSetId, 8, 6)}`,
    });
  }
  if (typeof contextMenu.tokenBudget === 'number') {
    badges.push({
      key: 'budget',
      label: `${settingsNumberFormatter.format(contextMenu.tokenBudget)} tokens`,
    });
  }
  if (typeof contextMenu.contextTokenCount === 'number') {
    badges.push({
      key: 'estimate',
      label: `${settingsNumberFormatter.format(contextMenu.contextTokenCount)} est.`,
    });
  }
  badges.push({
    key: 'report',
    label: `Report ${(contextMenu.includeFileReport ?? true) ? 'on' : 'off'}`,
  });
  badges.push({
    key: 'tree',
    label: `Tree ${contextMenu.includeProjectTree ? 'on' : 'off'}`,
  });

  if (badges.length === 0) {
    return null;
  }

  return (
    <div
      className="bs-context-summary text-[10px] text-muted-foreground"
      data-testid="assistant-context-summary"
    >
      <span className="font-semibold uppercase tracking-wide">Context</span>
      {badges.map((badge) => (
        <Badge className="bs-context-summary-badge text-[10px]" key={badge.key} variant="outline">
          {badge.label}
        </Badge>
      ))}
    </div>
  );
};

const settingsNumberFormatter = new Intl.NumberFormat();

const MAX_OUTPUT_DEFAULT = 2048;
const MAX_OUTPUT_MIN = 128;
const MAX_OUTPUT_MAX = 8192;
const MAX_OUTPUT_STEP = 64;

const ANTHROPIC_THINKING_DEFAULT = 12_000;
const ANTHROPIC_THINKING_MIN = 1024;
const ANTHROPIC_THINKING_MAX = 20_000;
const ANTHROPIC_THINKING_STEP = 256;

const OPENAI_EFFORT_OPTIONS: Array<{ value: OpenAiReasoningEffort | 'auto'; label: string }> = [
  { value: 'auto', label: 'Auto (medium)' },
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
];

const OPENAI_SUMMARY_OPTIONS: Array<{
  value: OpenAiReasoningSummary | 'off';
  label: string;
}> = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto' },
  { value: 'detailed', label: 'Detailed' },
];

const ANTHROPIC_EFFORT_OPTIONS: Array<{ value: AnthropicEffort | 'auto'; label: string }> = [
  { value: 'auto', label: 'Auto (high)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const GOOGLE_FLASH_THINKING_LEVELS: GoogleThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];
const GOOGLE_PRO_THINKING_LEVELS: GoogleThinkingLevel[] = ['low', 'high'];

interface ProviderSettingsPanelProps {
  modelName?: string | undefined;
  onSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  providerId?: string | undefined;
  settings?: AssistantProviderSettings | undefined;
}

type ProviderSettingsUpdate = (updates: AssistantProviderSettingsUpdate) => void;

interface ProviderSettingsSectionProps {
  disabled: boolean;
  onUpdate: ProviderSettingsUpdate;
  settings: AssistantProviderSettings;
}

const MaxOutputSection: FC<ProviderSettingsSectionProps> = ({ settings, onUpdate, disabled }) => {
  const maxOutputEnabled = typeof settings.maxOutputTokens === 'number';
  const maxOutputValue = clampNumber(
    settings.maxOutputTokens ?? MAX_OUTPUT_DEFAULT,
    MAX_OUTPUT_MIN,
    MAX_OUTPUT_MAX
  );

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Max output tokens
        </Label>
        <Switch
          checked={maxOutputEnabled}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onUpdate({
              maxOutputTokens: checked ? maxOutputValue : undefined,
            })
          }
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          className="h-8 text-xs"
          disabled={disabled || !maxOutputEnabled}
          inputMode="numeric"
          max={MAX_OUTPUT_MAX}
          min={MAX_OUTPUT_MIN}
          onChange={(event) => {
            const parsed = parseNumber(event.target.value);
            if (parsed === undefined) {
              onUpdate({ maxOutputTokens: undefined });
              return;
            }
            onUpdate({
              maxOutputTokens: clampNumber(parsed, MAX_OUTPUT_MIN, MAX_OUTPUT_MAX),
            });
          }}
          placeholder="Auto"
          type="number"
          value={maxOutputEnabled ? maxOutputValue : ''}
        />
        <span className="text-[10px] text-muted-foreground">
          {maxOutputEnabled ? settingsNumberFormatter.format(maxOutputValue) : 'Auto'}
        </span>
      </div>
      <input
        aria-label="Max output tokens"
        className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
        disabled={disabled || !maxOutputEnabled}
        max={MAX_OUTPUT_MAX}
        min={MAX_OUTPUT_MIN}
        onChange={(event) =>
          onUpdate({
            maxOutputTokens: clampNumber(
              Number(event.target.value),
              MAX_OUTPUT_MIN,
              MAX_OUTPUT_MAX
            ),
          })
        }
        step={MAX_OUTPUT_STEP}
        type="range"
        value={maxOutputEnabled ? maxOutputValue : MAX_OUTPUT_DEFAULT}
      />
    </div>
  );
};

const OpenAiReasoningSection: FC<ProviderSettingsSectionProps> = ({
  settings,
  onUpdate,
  disabled,
}) => (
  <div className="space-y-2 rounded-md bg-muted/30 p-2">
    <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
      OpenAI reasoning
    </Label>
    <div className="grid gap-2">
      <div className="space-y-1">
        <span className="text-[10px] text-muted-foreground">Effort</span>
        <Select
          disabled={disabled}
          onValueChange={(value) =>
            onUpdate({
              reasoningEffort: value === 'auto' ? undefined : (value as OpenAiReasoningEffort),
            })
          }
          value={settings.reasoningEffort ?? 'auto'}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Auto" />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_EFFORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <span className="text-[10px] text-muted-foreground">Reasoning summary</span>
        <Select
          disabled={disabled}
          onValueChange={(value) =>
            onUpdate({
              reasoningSummary: value === 'off' ? undefined : (value as OpenAiReasoningSummary),
            })
          }
          value={settings.reasoningSummary ?? 'off'}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Auto" />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_SUMMARY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  </div>
);

const AnthropicReasoningSection: FC<ProviderSettingsSectionProps> = ({
  settings,
  onUpdate,
  disabled,
}) => {
  const thinkingEnabled = typeof settings.anthropicThinkingBudgetTokens === 'number';
  const thinkingValue = clampNumber(
    settings.anthropicThinkingBudgetTokens ?? ANTHROPIC_THINKING_DEFAULT,
    ANTHROPIC_THINKING_MIN,
    ANTHROPIC_THINKING_MAX
  );

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Claude reasoning
      </Label>
      <div className="space-y-2">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Effort</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate({
                anthropicEffort: value === 'auto' ? undefined : (value as AnthropicEffort),
              })
            }
            value={settings.anthropicEffort ?? 'auto'}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              {ANTHROPIC_EFFORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 rounded-md border border-border bg-background p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Thinking budget
            </span>
            <Switch
              checked={thinkingEnabled}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onUpdate({
                  anthropicThinkingBudgetTokens: checked ? thinkingValue : undefined,
                })
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Input
              className="h-8 text-xs"
              disabled={disabled || !thinkingEnabled}
              inputMode="numeric"
              max={ANTHROPIC_THINKING_MAX}
              min={ANTHROPIC_THINKING_MIN}
              onChange={(event) => {
                const parsed = parseNumber(event.target.value);
                if (parsed === undefined) {
                  onUpdate({ anthropicThinkingBudgetTokens: undefined });
                  return;
                }
                onUpdate({
                  anthropicThinkingBudgetTokens: clampNumber(
                    parsed,
                    ANTHROPIC_THINKING_MIN,
                    ANTHROPIC_THINKING_MAX
                  ),
                });
              }}
              placeholder="Auto"
              type="number"
              value={thinkingEnabled ? thinkingValue : ''}
            />
            <span className="text-[10px] text-muted-foreground">
              {thinkingEnabled ? settingsNumberFormatter.format(thinkingValue) : 'Auto'}
            </span>
          </div>
          <input
            aria-label="Anthropic thinking budget"
            className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
            disabled={disabled || !thinkingEnabled}
            max={ANTHROPIC_THINKING_MAX}
            min={ANTHROPIC_THINKING_MIN}
            onChange={(event) =>
              onUpdate({
                anthropicThinkingBudgetTokens: clampNumber(
                  Number(event.target.value),
                  ANTHROPIC_THINKING_MIN,
                  ANTHROPIC_THINKING_MAX
                ),
              })
            }
            step={ANTHROPIC_THINKING_STEP}
            type="range"
            value={thinkingEnabled ? thinkingValue : ANTHROPIC_THINKING_DEFAULT}
          />
        </div>
      </div>
    </div>
  );
};

interface GoogleThinkingSectionProps extends ProviderSettingsSectionProps {
  modelName?: string | undefined;
}

const GoogleThinkingSection: FC<GoogleThinkingSectionProps> = ({
  settings,
  onUpdate,
  disabled,
  modelName,
}) => {
  const isGeminiPro = Boolean(modelName?.includes('gemini-3-pro-preview'));
  const googleThinkingLevels = isGeminiPro
    ? GOOGLE_PRO_THINKING_LEVELS
    : GOOGLE_FLASH_THINKING_LEVELS;

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Gemini thinking
      </Label>
      <div className="space-y-2">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Thinking level</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate({
                googleThinkingLevel: value === 'auto' ? undefined : (value as GoogleThinkingLevel),
              })
            }
            value={settings.googleThinkingLevel ?? 'auto'}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              {googleThinkingLevels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border bg-background p-2">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Include thoughts
            </p>
            <p className="text-[10px] text-muted-foreground">Stream internal reasoning (debug).</p>
          </div>
          <Switch
            checked={Boolean(settings.googleIncludeThoughts)}
            disabled={disabled}
            onCheckedChange={(checked) => onUpdate({ googleIncludeThoughts: checked })}
          />
        </div>
      </div>
    </div>
  );
};

const LocalThinkingSection: FC<ProviderSettingsSectionProps> = ({
  settings,
  onUpdate,
  disabled,
}) => (
  <div className="space-y-2 rounded-md bg-muted/30 p-2">
    <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
      Gemma thinking
    </Label>
    <div className="flex items-center justify-between rounded-md border border-border bg-background p-2">
      <div>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Enable thinking</p>
        <p className="text-[10px] text-muted-foreground">
          Include Gemma&apos;s internal reasoning phase before the final answer.
        </p>
      </div>
      <Switch
        checked={settings.localThinkingEnabled ?? true}
        disabled={disabled}
        onCheckedChange={(checked) => onUpdate({ localThinkingEnabled: checked })}
      />
    </div>
  </div>
);

export const ProviderSettingsPanel: FC<ProviderSettingsPanelProps> = ({
  providerId,
  modelName,
  settings,
  onSettingsChange,
}) => {
  if (!providerId) {
    return null;
  }

  const normalizedProvider = providerId.toLowerCase();
  const isOpenAiFamily = normalizedProvider === 'openai' || normalizedProvider === 'openrouter';
  const isAnthropic = normalizedProvider === 'anthropic';
  const isGoogle = normalizedProvider === 'google';
  const isLocal = normalizedProvider === 'local';

  if (!(isOpenAiFamily || isAnthropic || isGoogle || isLocal)) {
    return null;
  }

  const currentSettings = settings ?? {};
  const canUpdate = Boolean(onSettingsChange);
  const updateSettings: ProviderSettingsUpdate = (updates) => {
    if (!onSettingsChange) {
      return;
    }
    onSettingsChange(providerId, updates);
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Reasoning & Output
          </p>
          <p className="text-muted-foreground text-xs">
            Per-provider controls for reasoning depth and token limits.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <MaxOutputSection
          disabled={!canUpdate}
          onUpdate={updateSettings}
          settings={currentSettings}
        />
        {isOpenAiFamily ? (
          <OpenAiReasoningSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
        {isAnthropic ? (
          <AnthropicReasoningSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
        {isGoogle ? (
          <GoogleThinkingSection
            disabled={!canUpdate}
            modelName={modelName}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
        {isLocal ? (
          <LocalThinkingSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
      </div>
    </div>
  );
};

AssistantUiPanel.displayName = 'AssistantUiPanel';
