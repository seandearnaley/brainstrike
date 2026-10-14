import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  HostChildConversations,
  HostChildToolbar,
  HostChildWorkspaceChip,
  useAssistantRunNotifications,
  useBudgetGuardrailBinding,
} from '@brainstrike/app-shell';
import { AssistantThreadHostContext } from '@brainstrike/app-shell/assistant-thread-host-context';
import {
  BudgetGuardrailProvider,
  CommittedAssistantConversation,
  DebugBundleProvider,
  EditCheckpointProvider,
  RunVerdictProvider,
  useRewindContext,
} from '@brainstrike/assistant-ui';
import { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui/shell';
import { McpAppBridgeProvider } from '@brainstrike/mcp-app-host-ui';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CommittedHostCheckpoints } from './committed-host-checkpoints';
import {
  type CommittedHostConversation,
  createCommittedHostConversation,
  hostRunSettings,
} from './committed-host-conversation';
import { CommittedHostMcpInputView } from './committed-host-mcp-input-view';
import { CommittedWorkspaceControls } from './committed-workspace-controls';
import {
  type DesktopHostConnection,
  type DesktopHostConnectionState,
  windowHostConnection,
} from './desktop-host-connection';
import { createWindowThreadCapability } from './desktop-host-thread-capability';
import { HostApprovalStrip } from './host-approval-strip';
import { HostChildDetailsFold } from './host-child-details';
import { HostApprovalHistoryProvider } from './host-child-tree-notices';
import { hostMcpAppBridge } from './host-mcp-app-bridge';
import type { HostThreadCanvases } from './host-thread-canvases';
import { createHostDebugBundleBinding } from './host-thread-debug';
import type { HostThreadLedger } from './host-thread-ledger';
import { bindHostThreadToMainRoot } from './host-thread-root-binding';
import type { HostThreadRuns } from './host-thread-runs';
import {
  type ProviderReadErrors,
  useDesktopHostPresentation,
} from './use-desktop-host-presentation';
import { useHostLastTurn } from './use-host-last-turn';
import { useHostMemorySegment, withMemoryGate } from './use-host-memory-segment';
import { useHostThreadSelection } from './use-host-thread-selection';
import { useHostThreadUsage } from './use-host-thread-usage';

/** The existing checkpoint undo controls, fed from the thread's committed edits. */
function CommittedCheckpoints({
  checkpoints,
  children,
}: {
  readonly checkpoints: CommittedHostCheckpoints;
  readonly children: ReactNode;
}): ReactElement {
  const value = useSyncExternalStore(
    checkpoints.subscribe,
    checkpoints.getSnapshot,
    checkpoints.getSnapshot
  );
  return <EditCheckpointProvider value={value}>{children}</EditCheckpointProvider>;
}

/** The run verdict controls, fed from the thread's committed verdicts. */
function CommittedVerdicts({
  children,
  verdicts,
}: {
  readonly children: ReactNode;
  readonly verdicts: CommittedHostConversation['verdicts'];
}): ReactElement {
  const value = useSyncExternalStore(
    verdicts.subscribe,
    verdicts.getSnapshot,
    verdicts.getSnapshot
  );
  return <RunVerdictProvider value={value}>{children}</RunVerdictProvider>;
}

/** Committed effects are where a delegation starts or settles a child thread. */
function useCommittedEffectCount(conversation: CommittedHostConversation | undefined): number {
  const source = conversation?.source;
  const read = (): number =>
    source
      ?.getSnapshot()
      .rows.filter(
        ({ event }) => event.type === 'effect.started' || event.type === 'effect.finished'
      ).length ?? 0;
  return useSyncExternalStore(source?.subscribe ?? NO_SUBSCRIPTION, read, read);
}
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** BST-1932 (F15): a child's toolbar, live from its committed log. */
function HostChildDetails({
  source,
}: {
  readonly source: CommittedHostConversation['source'];
}): ReactElement | null {
  // A new source replays its log from the first row, so each source has its own fold.
  const folds = useRef(new WeakMap<object, HostChildDetailsFold>());
  const read = useCallback(() => {
    let fold = folds.current.get(source);
    if (!fold) {
      fold = new HostChildDetailsFold();
      folds.current.set(source, fold);
    }
    return fold.apply(source.getSnapshot().rows);
  }, [source]);
  const details = useSyncExternalStore(source.subscribe, read, read);
  return details ? (
    <div className="shrink-0 border-b px-2 py-1">
      <HostChildToolbar details={details} />
    </div>
  ) : null;
}

interface HostThreadProps {
  /** BST-1932: a child's view is tinted with its family colour. */
  readonly agentColor: string | undefined;
  readonly canvases: HostThreadCanvases;
  /** BST-1932: a delegated child's view, which sends input to the child while it runs. */
  readonly child: boolean;
  readonly client: HostClient;
  readonly label: string;
  readonly ledger: HostThreadLedger;
  readonly onRunningChange: ((threadId: string, running: boolean) => void) | undefined;
  readonly onTitleCommitted: () => void;
  readonly providerReadErrors: ProviderReadErrors | undefined;
  /** BST-2004: the connection's automatic attempt, or the user's Reconnect once it failed. */
  readonly reconnect: 'automatic' | (() => void) | undefined;
  /** BST-2004: the frame's next client after a lost one. */
  readonly replacement: (lost: HostClient) => Promise<HostClient>;
  readonly runs: HostThreadRuns;
  readonly threadId: string;
}

function HostThread({
  agentColor,
  canvases,
  child,
  client,
  label,
  ledger,
  onRunningChange,
  onTitleCommitted,
  providerReadErrors,
  reconnect,
  replacement,
  runs,
  threadId,
}: HostThreadProps): ReactElement {
  const explorer = useFileExplorerStoreContext();
  // ADR-0019: the composer's model is the host thread's selection.
  const selection = useHostThreadSelection(client, threadId);
  const readSelectionFolderId = useCallback(() => explorer.getState().currentFolderId, [explorer]);
  const { catalogKey, readConfiguration, readModelId, readPlanMode, ...presentation } =
    useDesktopHostPresentation(threadId, selection, readSelectionFolderId, providerReadErrors);
  const configuration = useRef(readConfiguration);
  const modelId = useRef(readModelId);
  const planMode = useRef(readPlanMode);
  // Legacy parity: a send binds an unbound thread to the Main root first.
  const bindRoot = useRef(async (): Promise<void> => undefined);
  useLayoutEffect(() => {
    bindRoot.current = () => {
      const { activeRootIds, rootDescriptors } = explorer.getState();
      const main = activeRootIds[0] ? rootDescriptors[activeRootIds[0]] : undefined;
      return bindHostThreadToMainRoot({
        client,
        mainRoot: main,
        threadId,
      });
    };
  }, [client, explorer, threadId]);
  useLayoutEffect(() => {
    configuration.current = readConfiguration;
    modelId.current = readModelId;
    planMode.current = readPlanMode;
  }, [readConfiguration, readModelId, readPlanMode]);
  const [conversation, setConversation] = useState<CommittedHostConversation>();
  // MCP Apps this thread's results mount: Main serves the shell, Core runs each call.
  const appBridge = useMemo(() => hostMcpAppBridge(client), [client]);
  useEffect(() => {
    // Commit-time view ownership survives StrictMode render replay without
    // starting duplicate subscriptions or disposing a still-mounted source.
    const current = createCommittedHostConversation({
      // A child is admitted under its root's binding, so only a root binds.
      ...(child ? {} : { bindThreadRoot: () => bindRoot.current() }),
      client,
      modelId: '',
      onTitleCommitted,
      readConfiguration: () => configuration.current(explorer.getState().currentFolderId),
      readModelId: () => modelId.current(),
      readPlanMode: () => planMode.current(),
      replacement,
      threadId,
    });
    setConversation(current);
    return () => current.close();
  }, [child, client, explorer, onTitleCommitted, replacement, threadId]);
  // A root thread's "Restore to before this message" goes to its owner (the
  // host); a delegated child's view offers none.
  const rewind = useRewindContext();
  // The meter's memory segment and the memory send gate: what admission would
  // answer for the run the next send starts.
  const planModeEnabled = presentation.planMode?.enabled === true;
  const readMemoryRequest = useCallback(
    () => ({
      ...hostRunSettings({
        modelId: '',
        readConfiguration: () => readConfiguration(explorer.getState().currentFolderId),
        readModelId,
        readPlanMode: () => planModeEnabled,
      }),
      threadId,
    }),
    [explorer, planModeEnabled, readConfiguration, readModelId, threadId]
  );
  const memory = useHostMemorySegment({
    blocked: presentation.isComposerDisabled === true,
    catalog: catalogKey,
    client,
    readRequest: readMemoryRequest,
    source: conversation?.source,
  });
  // Badges and OS notifications read this view's committed run state.
  const { onRunNotification } = useAssistantRunNotifications();
  const effects = useCommittedEffectCount(conversation);
  // The Changes surface's "Last Turn" follows this thread's committed runs.
  useHostLastTurn(threadId, conversation?.source);
  useEffect(
    () =>
      conversation ? runs.observe(threadId, conversation.source, onRunNotification) : undefined,
    [conversation, onRunNotification, runs, threadId]
  );
  // Cost views and the daily cap count this view's committed provider calls.
  useEffect(
    () => (conversation ? ledger.observe(threadId, conversation.source) : undefined),
    [conversation, ledger, threadId]
  );
  // The Canvas panel re-reads when this view's run commits a canvas version.
  useEffect(
    () => (conversation ? canvases.observe(threadId, conversation.source) : undefined),
    [canvases, conversation, threadId]
  );
  // The meter's thread total and cost: the same committed provider calls.
  const cumulativeUsage = useHostThreadUsage(ledger, threadId);
  // The composer's last-24h budget burn-down and send gate, host usage included.
  const budgetGuardrail = useBudgetGuardrailBinding();
  // Debug pack and Copy debug bundle, built from the host's committed log on
  // request; correlated diagnostics come from Main's retained diagnostic log.
  const debugBundle = useMemo(() => {
    const diagnostics = window.desktopDiagnostics;
    if (!diagnostics) {
      throw new Error('Desktop diagnostic reader unavailable');
    }
    return createHostDebugBundleBinding(client, threadId, diagnostics);
  }, [client, threadId]);
  // Steer (BST-588): the queue holds the message at its front while Core ends
  // the run after its step in flight; the message then starts the next turn.
  const [steeredRunId, setSteeredRunId] = useState<string>();
  const steer = useCallback(async (): Promise<boolean> => {
    const runId = await conversation?.steer();
    setSteeredRunId(runId);
    return runId !== undefined;
  }, [conversation]);
  return conversation ? (
    <McpAppBridgeProvider bridge={appBridge}>
      <div className="flex h-full min-h-0 flex-col">
        {child ? <HostChildDetails key={threadId} source={conversation.source} /> : null}
        <div className="min-h-0 flex-1">
          <CommittedCheckpoints checkpoints={conversation.checkpoints}>
            <CommittedVerdicts verdicts={conversation.verdicts}>
              <BudgetGuardrailProvider value={budgetGuardrail}>
                <DebugBundleProvider value={debugBundle}>
                  <HostApprovalHistoryProvider tree={conversation.approvals}>
                    <HostChildConversations revision={effects} threadId={threadId}>
                      <CommittedAssistantConversation
                        {...withMemoryGate(presentation, memory)}
                        {...(memory.omSegment ? { omSegment: memory.omSegment } : {})}
                        agentColor={agentColor}
                        approvalStrip={
                          <HostApprovalStrip
                            client={client}
                            self={child ? label : undefined}
                            tree={conversation.approvals}
                          />
                        }
                        commands={conversation.commands}
                        {...(cumulativeUsage ? { cumulativeUsage } : {})}
                        label={label}
                        onRunningChange={onRunningChange}
                        onSendActiveInput={child ? conversation.sendInput : undefined}
                        onSteerActiveRun={steer}
                        reconnect={reconnect}
                        rewind={child ? null : rewind}
                        store={conversation.store}
                        workspaceBar={
                          // A child shares its root's folder: named, never changed here.
                          child ? (
                            <HostChildWorkspaceChip threadId={threadId} />
                          ) : (
                            <CommittedWorkspaceControls threadId={threadId} />
                          )
                        }
                      />
                    </HostChildConversations>
                  </HostApprovalHistoryProvider>
                </DebugBundleProvider>
              </BudgetGuardrailProvider>
            </CommittedVerdicts>
          </CommittedCheckpoints>
        </div>
        {steeredRunId ? <SteeringStatus runId={steeredRunId} store={conversation.store} /> : null}
        {/* Core-owned MCP input: the dialog portals; status and alerts sit under the conversation. */}
        <CommittedHostMcpInputView input={conversation.mcpInput} />
      </div>
    </McpAppBridgeProvider>
  ) : (
    <div role="status">Connecting to the agent host…</div>
  );
}

/**
 * BST-2004: a thread view follows the frame's host connection. A replaced
 * host's client rebinds the view through the same path as a reload; until it
 * arrives, the lost client's view stays mounted and shows the disconnect.
 */
function ConnectedHostThread({
  connection,
  ...thread
}: Omit<HostThreadProps, 'client' | 'reconnect' | 'replacement'> & {
  readonly connection: DesktopHostConnection;
}): ReactElement {
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    connection.getSnapshot
  );
  const [client, setClient] = useState(state.kind === 'connected' ? state.client : undefined);
  if (state.kind === 'connected' && state.client !== client) {
    setClient(state.client);
  }
  const replacement = useCallback((lost: HostClient) => connection.replacement(lost), [connection]);
  if (!client) {
    return <div role="status">Connecting to the agent host…</div>;
  }
  return (
    <HostThread
      {...thread}
      client={client}
      reconnect={reconnectFor(state, connection)}
      replacement={replacement}
    />
  );
}

function reconnectFor(
  state: DesktopHostConnectionState,
  connection: DesktopHostConnection
): HostThreadProps['reconnect'] {
  if (state.kind === 'failed') {
    return connection.reconnect;
  }
  return state.kind === 'connecting' && state.automatic ? 'automatic' : undefined;
}

/** Visible while the steered run is still the thread's active run. */
function SteeringStatus({
  runId,
  store,
}: {
  readonly runId: string;
  readonly store: CommittedHostConversation['store'];
}): ReactElement | null {
  const activeRunId = useSyncExternalStore(
    store.subscribe,
    () => store.getCommittedView().activeRunId
  );
  return activeRunId === runId ? (
    <div aria-live="polite" className="px-3 py-1 text-muted-foreground text-xs" role="status">
      Steering: stopping after this step, then sending your message…
    </div>
  ) : null;
}

// One lazy client capability per actual renderer frame, independent of React replay.
const windowThreadCapability = createWindowThreadCapability(
  ({
    canvases,
    catalogLoaded,
    child,
    connection,
    ledger,
    onRunningChange,
    onTitleCommitted,
    owned,
    providerReadErrors,
    runs,
    threadId,
  }) => {
    // Persisted tabs render before catalog hydration. The observed legacy
    // Mastra initialization for these SQLite-owned IDs must not claim them.
    if (!(owned || catalogLoaded)) {
      return <div role="status">Loading assistant threads…</div>;
    }
    // The agent host is Desktop's only conversation owner: a thread its catalog
    // does not list fails visibly instead of mounting another runtime.
    return owned ? (
      <ConnectedHostThread
        agentColor={child?.color}
        canvases={canvases}
        child={child !== undefined}
        connection={connection}
        // A child's region is named by its call sign, like its workspace tab.
        label={child?.callSign ?? 'Assistant'}
        ledger={ledger}
        onRunningChange={onRunningChange}
        onTitleCommitted={onTitleCommitted}
        providerReadErrors={providerReadErrors}
        runs={runs}
        threadId={threadId}
      />
    ) : (
      <div aria-label="Agent host error" className="p-4 text-destructive text-sm" role="alert">
        This thread is not owned by the agent host.
      </div>
    );
  },
  windowHostConnection()
);

/** New roots hydrate from the committed host; existing history keeps its original owner. */
export function DesktopHostThreadProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <AssistantThreadHostContext.Provider value={windowThreadCapability}>
      {children}
    </AssistantThreadHostContext.Provider>
  );
}
