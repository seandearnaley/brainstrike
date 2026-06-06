import {
  ActionBarPrimitive,
  type AssistantDataUIProps,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ChainOfThoughtPrimitive,
  ComposerPrimitive,
  type DataMessagePartComponent,
  MessagePrimitive,
  type ThreadHistoryAdapter,
  ThreadPrimitive,
  useAssistantDataUI,
  useAui,
  useAuiState,
  useLocalRuntime,
  useMessagePartReasoning,
} from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type LocalLlmBackendFactory,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract';
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
  SquareIcon,
} from 'lucide-react';
import * as m from 'motion/react-m';
import {
  type FC,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
// @assistant-ui/styles v0.3.x consolidated all styles into index.css
import '@assistant-ui/styles/index.css';
import './overrides.css';
import { Badge } from '../badge';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { ModelPicker } from '../model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../model-picker/types';
import { Progress } from '../progress';
import { ControlsMenu } from './assistant-controls-menu';
import { AssistantMessageText, preloadMarkdownText } from './assistant-message-text';
import { AssistantRunTimeline, resolveAssistantRunEventStatus } from './assistant-run-timeline';
import { AssistantToolApprovalNotice } from './assistant-tool-approval-notice';
import { clampProgress, getLocalModelStatusLabel } from './assistant-ui-panel-utils';
import { useBrainstrikeDataStreamRuntime } from './data-stream-runtime';
import { createLocalModelAdapter, disposeLocalBackend } from './local-runtime-adapter';
import { ToolFallback } from './tool-fallback';
import { TooltipIconButton } from './tooltip-icon-button';

const AssistantRunTimelineDataPart: DataMessagePartComponent = ({ data }) => {
  const statusOverride = useAuiState((state) =>
    resolveAssistantRunEventStatus(state.thread.messages, data)
  );
  return <AssistantRunTimeline data={data} statusOverride={statusOverride} />;
};

const AssistantToolApprovalDataPart: DataMessagePartComponent = ({ data }) => (
  <AssistantToolApprovalNotice data={data} />
);

const assistantRunTimelineDataUI = {
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
  render: AssistantRunTimelineDataPart,
} satisfies AssistantDataUIProps;

const assistantToolApprovalDataUI = {
  name: TOOL_APPROVAL_DATA_NAME,
  render: AssistantToolApprovalDataPart,
} satisfies AssistantDataUIProps;

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
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';

export interface AssistantUiPanelProps {
  className?: string;
  completePreparedRequest?: (
    requestData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void> | void;
  disabled?: boolean;
  disabledReason?: string;
  historyAdapter?: ThreadHistoryAdapter;
  loadLocalLlmBackend?: LocalLlmBackendFactory;
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
          aria-label="Model downloading progress"
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
  const isContinuation = useAuiState((state) => {
    const [firstChainPart] = state.chainOfThought.parts;
    if (!firstChainPart) {
      return false;
    }

    const startIndex = state.message.parts.indexOf(firstChainPart);
    if (startIndex <= 0) {
      return false;
    }

    return state.message.parts
      .slice(0, startIndex)
      .some((part) => part.type === 'reasoning' || part.type === 'tool-call');
  });
  const initializedRef = useRef(false);
  const reasoningPanelId = useId();

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    aui.chainOfThought().setCollapsed(true);
  }, [aui]);

  return (
    <ChainOfThoughtPrimitive.Root
      className={cn(
        'bs-chain-of-thought max-w-xl',
        collapsed ? 'mr-1 mb-1 inline-block align-top' : 'mb-2 block'
      )}
    >
      <button
        aria-controls={reasoningPanelId}
        aria-expanded={!collapsed}
        aria-label={
          collapsed
            ? isContinuation
              ? 'Show additional reasoning'
              : 'Show reasoning'
            : isContinuation
              ? 'Hide additional reasoning'
              : 'Hide reasoning'
        }
        className={cn(
          'inline-flex h-8 max-w-full items-center rounded-full border border-border/70 bg-muted/20 text-left font-medium text-foreground text-xs transition-colors hover:bg-muted/35',
          isContinuation ? 'w-8 justify-center px-0' : 'gap-2 px-2.5'
        )}
        data-testid="local-chain-of-thought"
        onClick={() => aui.chainOfThought().setCollapsed(!collapsed)}
        type="button"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-sky-500" />
        {isContinuation ? null : (
          <>
            <span className="truncate">Thinking</span>
            {collapsed ? (
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </>
        )}
      </button>
      <div
        className="bs-chain-of-thought-panel mt-2 border-border/70 border-l pl-3"
        hidden={collapsed}
        id={reasoningPanelId}
      >
        {collapsed ? null : (
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
        )}
      </div>
    </ChainOfThoughtPrimitive.Root>
  );
};

const AssistantDataRendererRegistration: FC = () => {
  useAssistantDataUI(assistantRunTimelineDataUI);
  useAssistantDataUI(assistantToolApprovalDataUI);

  return null;
};

// Keep this in sync with the collapsed-history nth-last-child selector in overrides.css.
const COLLAPSED_HISTORY_VISIBLE_MESSAGES = 8;

const ThreadHistoryControl: FC<{
  controlsId: string;
  expanded: boolean;
  hiddenMessageCount: number;
  onExpandedChange: (expanded: boolean) => void;
}> = ({ controlsId, expanded, hiddenMessageCount, onExpandedChange }) => {
  if (hiddenMessageCount <= 0) {
    return null;
  }

  return (
    <div aria-live="polite" className="bs-history-control" data-testid="assistant-history-control">
      <button
        aria-controls={controlsId}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${hiddenMessageCount} previous messages`}
        className="bs-history-control-button"
        data-testid="assistant-history-toggle"
        onClick={() => onExpandedChange(!expanded)}
        type="button"
      >
        {expanded ? (
          <ChevronUpIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
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
  const contentId = useId();
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
        id={contentId}
        initial={false}
        ref={contentRef}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        {children}
      </m.div>
      {collapsed ? <div aria-hidden="true" className="bs-expandable-message-fade" /> : null}
      {hasOverflow ? (
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={expanded ? 'Show less message content' : 'Show more message content'}
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
  disabled: boolean;
  disabledReason: string | undefined;
  loadLocalLlmBackend?: LocalLlmBackendFactory | undefined;
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
  loadLocalLlmBackend,
  modelId,
  onLoadingStateChange,
  toolMenu,
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
        ...(loadLocalLlmBackend ? { loadBackend: loadLocalLlmBackend } : {}),
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
      loadLocalLlmBackend,
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

  const runtime = useBrainstrikeDataStreamRuntime({
    api,
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
}) => {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const messageCount = useAuiState((state) => state.thread.messages.length);
  const hiddenMessageCount = Math.max(0, messageCount - COLLAPSED_HISTORY_VISIBLE_MESSAGES);
  const historyCollapsed = hiddenMessageCount > 0 && !historyExpanded;
  const messagesRegionId = useId();

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bs-thread flex h-full min-h-0 flex-col"
      data-history-collapsed={historyCollapsed ? 'true' : undefined}
    >
      <AssistantDataRendererRegistration />
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
        id={messagesRegionId}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnRunStart={false}
      >
        {disabledReason && (
          <p aria-live="polite" className="px-4 py-3 text-muted-foreground text-xs">
            {disabledReason}
          </p>
        )}
        <ThreadHistoryControl
          controlsId={messagesRegionId}
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
  disabled = false,
  disabledReason,
  historyAdapter,
  loadLocalLlmBackend,
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
          disabled={disabled}
          disabledReason={disabledReason}
          key={threadKey ? `local:${threadKey}` : 'local'}
          loadLocalLlmBackend={loadLocalLlmBackend}
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
          }}
        />
      </div>

      <AssistantActionBar />

      <BranchPicker className="col-start-2 row-start-2 mr-2 -ml-2" />
    </MessagePrimitive.Root>
  );
};

export const ASSISTANT_ACTION_BAR_CLASSNAME =
  'col-start-3 row-start-2 -ml-1 flex gap-0.5 text-muted-foreground data-[floating]:absolute';
export const ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME = 'size-5';

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    autohideFloat="single-branch"
    className={ASSISTANT_ACTION_BAR_CLASSNAME}
    hideWhenRunning
  >
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton
        aria-label="Copy message"
        className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}
        tooltip="Copy"
      >
        <MessagePrimitive.If copied>
          <CheckIcon className="size-3.5" />
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <CopyIcon className="size-3.5" />
        </MessagePrimitive.If>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton
        aria-label="Regenerate response"
        className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}
        tooltip="Retry"
      >
        <RefreshCwIcon className="size-3.5" />
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
            modelName={modelName}
            onProviderSettingsChange={onProviderSettingsChange}
            providerSettings={providerSettings}
            selectedProvider={selectedProvider}
            toolMenu={toolMenu}
          />
        </div>
      </div>
      <div className="bs-composer-context-slot" />
    </div>
  );
};

export { ProviderSettingsPanel } from './provider-settings-panel';

AssistantUiPanel.displayName = 'AssistantUiPanel';
