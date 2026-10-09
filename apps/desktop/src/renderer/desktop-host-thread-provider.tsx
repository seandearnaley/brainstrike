import type { HostClient } from '@brainstrike/agent-host/browser';
import { useAssistantRunNotifications, useBudgetGuardrailBinding } from '@brainstrike/app-shell';
import { AssistantThreadHostContext } from '@brainstrike/app-shell/assistant-thread-host-context';
import {
  BudgetGuardrailProvider,
  CommittedAssistantConversation,
  DebugBundleProvider,
  EditCheckpointProvider,
} from '@brainstrike/assistant-ui';
import { useOptionalPGliteDatabase } from '@brainstrike/db/react';
import { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui/shell';
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
} from './committed-host-conversation';
import { CommittedHostMcpInputView } from './committed-host-mcp-input-view';
import { CommittedWorkspaceControls } from './committed-workspace-controls';
import { readDesktopHostModel } from './desktop-host-configuration';
import { createWindowThreadCapability } from './desktop-host-thread-capability';
import { createHostDebugBundleBinding } from './host-thread-debug';
import type { HostThreadLedger } from './host-thread-ledger';
import type { HostThreadRuns } from './host-thread-runs';
import {
  type ProviderReadErrors,
  useDesktopHostPresentation,
} from './use-desktop-host-presentation';
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

function HostThread({
  client,
  ledger,
  onRunningChange,
  onTitleCommitted,
  providerReadErrors,
  runs,
  threadId,
}: {
  readonly client: HostClient;
  readonly ledger: HostThreadLedger;
  readonly onRunningChange: ((threadId: string, running: boolean) => void) | undefined;
  readonly onTitleCommitted: () => void;
  readonly providerReadErrors: ProviderReadErrors | undefined;
  readonly runs: HostThreadRuns;
  readonly threadId: string;
}): ReactElement {
  const explorer = useFileExplorerStoreContext();
  const { readConfiguration, readPlanMode, ...presentation } = useDesktopHostPresentation(
    threadId,
    providerReadErrors
  );
  const configuration = useRef(readConfiguration);
  const planMode = useRef(readPlanMode);
  useLayoutEffect(() => {
    configuration.current = readConfiguration;
    planMode.current = readPlanMode;
  }, [readConfiguration, readPlanMode]);
  const [conversation, setConversation] = useState<CommittedHostConversation>();
  useEffect(() => {
    // Commit-time view ownership survives StrictMode render replay without
    // starting duplicate subscriptions or disposing a still-mounted source.
    const current = createCommittedHostConversation({
      client,
      modelId: '',
      onTitleCommitted,
      readConfiguration: () => configuration.current(explorer.getState().currentFolderId),
      readModelId: () => readDesktopHostModel(threadId),
      readPlanMode: () => planMode.current(),
      threadId,
    });
    setConversation(current);
    return () => current.close();
  }, [client, explorer, onTitleCommitted, threadId]);
  // Badges and OS notifications read this view's committed run state.
  const { onRunNotification } = useAssistantRunNotifications();
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
  // The meter's thread total and cost: the same committed provider calls.
  const cumulativeUsage = useHostThreadUsage(ledger, threadId);
  // The composer's last-24h budget burn-down and send gate, host usage included.
  const budgetGuardrail = useBudgetGuardrailBinding();
  // Debug pack and Copy debug bundle, built from the host's committed log on
  // request; correlated diagnostics come from the renderer's diagnostic store.
  const diagnostics = useOptionalPGliteDatabase();
  const debugBundle = useMemo(
    () => (diagnostics ? createHostDebugBundleBinding(client, threadId, diagnostics) : null),
    [client, diagnostics, threadId]
  );
  // Steer (BST-588): the queue holds the message at its front while Core ends
  // the run after its step in flight; the message then starts the next turn.
  const [steeredRunId, setSteeredRunId] = useState<string>();
  const steer = useCallback(async (): Promise<boolean> => {
    const runId = await conversation?.steer();
    setSteeredRunId(runId);
    return runId !== undefined;
  }, [conversation]);
  return conversation ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <CommittedCheckpoints checkpoints={conversation.checkpoints}>
          <BudgetGuardrailProvider value={budgetGuardrail}>
            <DebugBundleProvider value={debugBundle}>
              <CommittedAssistantConversation
                {...presentation}
                commands={conversation.commands}
                {...(cumulativeUsage ? { cumulativeUsage } : {})}
                label="Assistant"
                onRunningChange={onRunningChange}
                onSteerActiveRun={steer}
                store={conversation.store}
                workspaceBar={<CommittedWorkspaceControls threadId={threadId} />}
              />
            </DebugBundleProvider>
          </BudgetGuardrailProvider>
        </CommittedCheckpoints>
      </div>
      {steeredRunId ? <SteeringStatus runId={steeredRunId} store={conversation.store} /> : null}
      {/* Core-owned MCP input: the dialog portals; status and alerts sit under the conversation. */}
      <CommittedHostMcpInputView input={conversation.mcpInput} />
    </div>
  ) : (
    <div role="status">Connecting to the agent host…</div>
  );
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
    catalogLoaded,
    host,
    ledger,
    onRunningChange,
    onTitleCommitted,
    providerReadErrors,
    runs,
    threadId,
  }) => {
    // Persisted tabs render before catalog hydration. The observed legacy
    // Mastra initialization for these SQLite-owned IDs must not claim them.
    if (!(host || catalogLoaded)) {
      return <div role="status">Loading assistant threads…</div>;
    }
    return host ? (
      <HostThread
        client={host}
        ledger={ledger}
        onRunningChange={onRunningChange}
        onTitleCommitted={onTitleCommitted}
        providerReadErrors={providerReadErrors}
        runs={runs}
        threadId={threadId}
      />
    ) : undefined;
  }
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
