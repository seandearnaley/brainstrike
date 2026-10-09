import { type AssistantMemoryThread, useAssistantThreadStore } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { getAgentColorStyles, isAgentColor } from '@brainstrike/types/agent-color';
import { Breadcrumbs } from '@brainstrike/ui';
import { type CSSProperties, useEffect, useState } from 'react';
import { getDelegatedColorPresentation } from './agent-color-presentation';
import type {
  AssistantThreadHostCapability,
  AssistantThreadHostChild,
} from './assistant-thread-host-context';
import { ASSISTANT_THREAD_ICON_PRESENTATION } from './assistant-thread-presentation';
import { openHostChildTab } from './open-host-child-tab';

const logger = createLogger('HostChildConversationHeader');
const Icon = ASSISTANT_THREAD_ICON_PRESENTATION.message.iconComponent;
const MAIN_CONVERSATION = 'Main conversation';

/** A child's delegation trail, outermost child first, ending with the child itself. */
interface HostChildAncestry {
  readonly rootThreadId: string;
  readonly trail: readonly AssistantThreadHostChild[];
}

/** Each ancestor child resolves from its own committed origin, up to the top-level thread. */
async function loadHostChildAncestry(
  host: AssistantThreadHostCapability,
  child: AssistantThreadHostChild
): Promise<HostChildAncestry> {
  if (!host.resolveChildThread) {
    throw new Error('This child conversation is not owned by the agent host.');
  }
  const trail = [child];
  let parentThreadId = child.parentThreadId;
  for (let level = child.depth - 1; level > 0; level -= 1) {
    const parent = await host.resolveChildThread(parentThreadId);
    trail.unshift(parent);
    parentThreadId = parent.parentThreadId;
  }
  return { rootThreadId: parentThreadId, trail };
}

function findThread(
  threads: Readonly<Record<string, readonly AssistantMemoryThread[]>>,
  threadId: string | undefined
): AssistantMemoryThread | undefined {
  return threadId === undefined
    ? undefined
    : Object.values(threads)
        .flat()
        .find((thread) => thread.id === threadId);
}

type Loaded =
  | { readonly ancestry: HostChildAncestry; readonly child: AssistantThreadHostChild }
  | { readonly child: AssistantThreadHostChild; readonly error: Error };

/**
 * BST-1932: a host child conversation's header. Its ancestry runs from the
 * top-level thread through each ancestor's call sign, each opening where it
 * lives; then the child's own mark and call sign, its parent's colour cue,
 * and the workspace it shares with its root.
 */
export function HostChildConversationHeader({
  child,
  host,
}: {
  readonly child: AssistantThreadHostChild;
  readonly host: AssistantThreadHostCapability;
}) {
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    let active = true;
    loadHostChildAncestry(host, child).then(
      (ancestry) => {
        if (active) {
          setLoaded({ ancestry, child });
        }
      },
      (error: unknown) => {
        if (active) {
          setLoaded({ child, error: error instanceof Error ? error : new Error(String(error)) });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [child, host]);
  const current = loaded?.child === child ? loaded : undefined;
  const ancestry = current && 'ancestry' in current ? current.ancestry : undefined;
  const root = useAssistantThreadStore((state) =>
    findThread(state.threadsByResourceId, ancestry?.rootThreadId)
  );
  const rootTitle = root?.title ?? MAIN_CONVERSATION;
  const parent = ancestry?.trail.at(-2);
  const parentColor = parent ? parent.color : root?.metadata?.color;
  const parentName = parent?.callSign ?? rootTitle;
  if (!isAgentColor(child.color)) {
    throw new Error('The child conversation colour is not an agent colour.');
  }
  const appearance = getDelegatedColorPresentation(child.color);
  const open = (threadId: string): void => {
    const ancestor = ancestry?.trail.find((candidate) => candidate.threadId === threadId);
    if (ancestor) {
      openHostChildTab(ancestor);
      return;
    }
    if (!root) {
      logger.error('The top-level conversation is not loaded', { threadId });
      return;
    }
    useAssistantThreadStore.getState().openThreadTab(root.resourceId, root.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`assistant-thread-tab-${root.id}`)?.focus();
    });
  };
  const operatingRoot = root?.metadata?.operatingRootDisplayName;
  return (
    <header
      className={`shrink-0 space-y-2 border-b px-4 py-3 ${appearance.idleClassName}`}
      data-agent-color={child.color}
      style={appearance.style}
    >
      {current ? (
        'error' in current ? (
          <p className="text-destructive text-xs" role="alert">
            {current.error.message}
          </p>
        ) : (
          <Breadcrumbs
            ariaLabel="Conversation ancestry"
            className="[&_ol]:flex-wrap"
            onSegmentClick={open}
            segments={[
              { label: rootTitle, path: current.ancestry.rootThreadId },
              ...current.ancestry.trail.map((ancestor) => ({
                label: ancestor.callSign,
                path: ancestor.threadId,
              })),
            ]}
          />
        )
      ) : (
        <p className="text-muted-foreground text-xs" role="status">
          Loading ancestry…
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className={`bs-agent-solid-mark rounded-md border p-1 ${appearance.markClassName}`}>
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <h2 className="truncate font-semibold text-sm">{child.callSign}</h2>
        {ancestry && isAgentColor(parentColor) ? (
          <span
            aria-label={`Parent: ${parentName}`}
            className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
            role="img"
            title={`Parent: ${parentName}`}
          >
            <span
              aria-hidden="true"
              className="bs-agent-parent-cue size-2 rounded-full"
              style={getAgentColorStyles(parentColor) as CSSProperties}
            />
            Parent
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs" data-testid="child-workspace-mode">
        {operatingRoot
          ? `Shared workspace: ${operatingRoot}`
          : 'Shared workspace: tools select an open folder'}
      </p>
    </header>
  );
}
