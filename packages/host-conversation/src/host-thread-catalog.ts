/**
 * A host catalog entry as the shell's thread list shows it (BST-1940): its
 * identity, binding, committed presentation and times. Desktop's and the
 * web's thread hosts list their host's threads through it.
 */
import type { HostLogRow, HostResults } from '@brainstrike/agent-host/protocol';
import { DEFAULT_THREAD_TITLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
// Types only from the assistant-data barrel: its values reach the PGlite
// repositories, which no browser bundle of this package may load (BST-2106).
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { ASSISTANT_THREAD_ICON_IDS, type AssistantThreadIconId } from '@brainstrike/types';
import {
  AGENT_SEMANTIC_COLOR_IDS as ASSISTANT_THREAD_COLOR_IDS,
  type AgentSemanticColor as AssistantThreadColorId,
} from '@brainstrike/types/agent-color';

const logger = createLogger('HostThreadCatalog');

export type HostCatalogEntry = Pick<
  HostResults['thread/list']['threads'][number],
  'binding' | 'color' | 'createdAt' | 'damage' | 'icon' | 'threadId' | 'title' | 'updatedAt'
>;

/** The catalog's committed title, colour and icon (each absent until set). */
interface HostPresentation {
  readonly color?: string | undefined;
  readonly icon?: string | undefined;
  readonly title?: string | undefined;
}

const isColor = (value: string): value is AssistantThreadColorId =>
  (ASSISTANT_THREAD_COLOR_IDS as readonly string[]).includes(value);
const isIcon = (value: string): value is AssistantThreadIconId =>
  (ASSISTANT_THREAD_ICON_IDS as readonly string[]).includes(value);

/** Committed colour and icon this renderer can draw; an unknown ID is reported, not drawn. */
function presentedMetadata(threadId: string, { color, icon }: HostPresentation) {
  if ((color !== undefined && !isColor(color)) || (icon !== undefined && !isIcon(icon))) {
    logger.warn('Host thread has a colour or icon this renderer cannot draw', {
      color,
      icon,
      threadId,
    });
  }
  return {
    ...(color !== undefined && isColor(color) ? { color } : {}),
    ...(icon !== undefined && isIcon(icon) ? { icon } : {}),
  };
}

/**
 * Transient display projection of the owner's catalog entry: identity, binding
 * and timestamps. A damaged thread stays listed, its damage shown as a read failure.
 */
export function projectHostThread(
  resourceId: string,
  { binding, createdAt, damage, threadId, updatedAt, ...presentation }: HostCatalogEntry
): AssistantMemoryThread {
  const metadata = { ...(binding ?? {}), ...presentedMetadata(threadId, presentation) };
  return {
    createdAt: new Date(createdAt),
    id: threadId,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(damage === undefined ? {} : { readFailure: damage }),
    resourceId,
    title: presentation.title ?? DEFAULT_THREAD_TITLE,
    updatedAt: new Date(updatedAt),
  };
}

/** A thread the host has just started: its creation is its only committed fact. */
export function projectStartedHostThread(
  threadId: string,
  resourceId: string,
  rows: readonly HostLogRow[]
): AssistantMemoryThread {
  const started = rows.find((row) => row.event.type === 'thread.started');
  if (started?.ts === undefined) {
    throw new Error('Host thread has no committed creation timestamp');
  }
  return projectHostThread(resourceId, {
    binding: null,
    createdAt: started.ts,
    threadId,
    updatedAt: started.ts,
  });
}
