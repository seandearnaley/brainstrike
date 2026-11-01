import { type AppendMessage, MessageNotSentError } from '@assistant-ui/react';
import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostRunSelection } from '@brainstrike/agent-host/protocol';
import { useBudgetGuardrailBinding, WorkspaceTrustPrompt } from '@brainstrike/app-shell';
import {
  createHostAssistantThreadRepository,
  useAssistantThreadHost,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import { newThreadId, useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  BudgetGuardrailProvider,
  type CommittedAssistantCommands,
  CommittedAssistantConversation,
  type CommittedAssistantLogSource,
  type CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '@brainstrike/assistant-ui';
import { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui/shell';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { hostRunSettings, settleLostSend } from './committed-host-conversation';
import { CommittedWorkspaceControls } from './committed-workspace-controls';
import { bindHostThreadToMainRoot } from './host-thread-root-binding';
import type { HostThreadRuns } from './host-thread-runs';
import { sendNewThreadFirstMessage } from './new-thread-first-send';
import {
  type ProviderReadErrors,
  useDesktopHostPresentation,
} from './use-desktop-host-presentation';
import type { HostThreadSelectionBinding } from './use-host-thread-selection';

/**
 * A thread that does not exist yet has no committed rows to show; it is
 * connected while the host client it would be created through is open, so a
 * lost host offers Reconnect as an existing thread does.
 */
class NewThreadSource implements CommittedAssistantLogSource {
  private client: HostClient | undefined;
  private readonly listeners = new Set<() => void>();
  private snapshot: CommittedAssistantLogSourceSnapshot = {
    connected: true,
    error: undefined,
    isLoading: false,
    rows: [],
  };
  readonly getSnapshot = (): CommittedAssistantLogSourceSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  follow(client: HostClient): void {
    if (client === this.client) {
      return;
    }
    this.client = client;
    this.publish(true);
    const closed = (): void => {
      if (this.client === client) {
        this.publish(false);
      }
    };
    client.closed.then(closed, closed);
  }
  private publish(connected: boolean): void {
    if (connected === this.snapshot.connected) {
      return;
    }
    this.snapshot = { ...this.snapshot, connected };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** ADR-0019: the composer's pick, held until the first send commits it as the thread's selection. */
function useNewThreadSelection(): HostThreadSelectionBinding {
  const [selection, setSelection] = useState<HostRunSelection | null>(null);
  const set = useCallback(async (modelId: string, configuration: Record<string, unknown>) => {
    setSelection({ configuration: JSON.parse(JSON.stringify(configuration)), modelId });
  }, []);
  return { selection, set };
}

/**
 * The new-thread composer: the thread's own composer and controls before the
 * host thread exists. Its folder, checkout and model choices are the new
 * thread's draft (`newThreadId`), which its first send commits to the host
 * thread it creates (`sendNewThreadFirstMessage`).
 */
export function NewHostThread({
  client,
  providerReadErrors,
  reconnect,
  replacement,
  resourceId,
  runs,
}: {
  readonly client: HostClient;
  readonly providerReadErrors: ProviderReadErrors | undefined;
  readonly reconnect: 'automatic' | (() => void) | undefined;
  readonly replacement: (lost: HostClient) => Promise<HostClient>;
  readonly resourceId: string;
  /** The window's committed run state, which the view the first send opens announces from. */
  readonly runs: HostThreadRuns;
}): ReactElement {
  const host = useAssistantThreadHost();
  const explorer = useFileExplorerStoreContext();
  const threadId = newThreadId(resourceId);
  const selection = useNewThreadSelection();
  const readSelectionFolderId = useCallback(() => explorer.getState().currentFolderId, [explorer]);
  const {
    catalogKey: _catalogKey,
    readConfiguration,
    readModelId,
    readPlanMode,
    ...presentation
  } = useDesktopHostPresentation(threadId, selection, readSelectionFolderId, providerReadErrors);
  const settings = useRef({ readConfiguration, readModelId, readPlanMode, selection });
  useLayoutEffect(() => {
    settings.current = { readConfiguration, readModelId, readPlanMode, selection };
  }, [readConfiguration, readModelId, readPlanMode, selection]);
  const [source] = useState(() => new NewThreadSource());
  const [store] = useState(
    () =>
      new CommittedAssistantLogStore({
        identifyRun: () => {
          throw new Error('A new thread has no committed runs.');
        },
        source,
        threadId,
      })
  );
  useEffect(() => source.follow(client), [client, source]);
  useEffect(() => () => store.dispose(), [store]);
  // One first send creates the thread; another before it opens keeps its text.
  const sending = useRef(false);
  const commands = useMemo<CommittedAssistantCommands>(() => {
    if (!host) {
      throw new Error('The new-thread composer requires the attached agent host.');
    }
    const repository = createHostAssistantThreadRepository(host);
    // The draft binding (a folder or worktree picked here), then the legacy
    // default: an unbound thread binds to the Main root.
    const bind = async (created: string): Promise<void> => {
      const draft = useAssistantThreadStore.getState().newThreadMetadataByResourceId[resourceId];
      if (draft) {
        await repository.updateThreadMetadata(created, draft);
      }
      const { activeRootIds, rootDescriptors } = explorer.getState();
      await bindHostThreadToMainRoot({
        client,
        mainRoot: activeRootIds[0] ? rootDescriptors[activeRootIds[0]] : undefined,
        threadId: created,
      });
    };
    const sendFirst = async (message: AppendMessage): Promise<void> => {
      if (sending.current) {
        throw new MessageNotSentError('The new thread is still being created.');
      }
      sending.current = true;
      const current = settings.current;
      await sendNewThreadFirstMessage(
        {
          bind,
          client,
          commit: (thread) =>
            useAssistantThreadStore.getState().commitNewThread(resourceId, thread),
          host,
          resourceId,
          runSettings: () =>
            hostRunSettings({
              modelId: '',
              readConfiguration: () =>
                current.readConfiguration(explorer.getState().currentFolderId),
              readModelId: current.readModelId,
              readPlanMode: current.readPlanMode,
            }),
          selection: current.selection.selection ?? null,
          sentBeforeOpening: (created, commandId) => runs.sentBeforeOpening(created, commandId),
          settleLost: (created) => settleLostSend(client, replacement, created),
        },
        message
      ).finally(() => {
        sending.current = false;
      });
    };
    return { onNew: sendFirst };
  }, [client, explorer, host, replacement, resourceId, runs]);
  const budgetGuardrail = useBudgetGuardrailBinding();
  return (
    <BudgetGuardrailProvider value={budgetGuardrail}>
      <CommittedAssistantConversation
        {...presentation}
        commands={commands}
        label="Assistant"
        {...(reconnect === undefined ? {} : { reconnect })}
        store={store}
        welcome
        workspaceBar={<CommittedWorkspaceControls threadId={threadId} />}
        workspaceNotice={<WorkspaceTrustPrompt />}
      />
    </BudgetGuardrailProvider>
  );
}
