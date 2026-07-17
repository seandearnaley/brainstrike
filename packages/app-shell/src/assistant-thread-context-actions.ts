import {
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  type ContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import { Copy } from 'lucide-react';
import type { AssistantMemoryThread } from './assistant-memory-repository';

type AssistantThreadTargetKind = 'assistant-thread' | 'assistant-thread-tab';

export function assistantThreadToTarget<K extends AssistantThreadTargetKind>(
  thread: Pick<AssistantMemoryThread, 'id' | 'resourceId' | 'title'>,
  kind: K
): TargetOf<K> {
  return {
    id: thread.id,
    kind,
    resourceId: thread.resourceId,
    title: thread.title,
  } as TargetOf<K>;
}

async function copyThreadValue(
  services: ActionServices,
  value: string,
  successMessage: string
): Promise<ActionOutcome> {
  if (!services.clipboard) {
    return { error: 'Clipboard service unavailable', ok: false };
  }
  const outcome = await services.clipboard.writeText(value);
  return outcome.ok ? { message: successMessage, ok: true } : outcome;
}

const copyThreadTitle: ContextAction<AssistantThreadTargetKind> = {
  appliesTo: ['assistant-thread', 'assistant-thread-tab'],
  group: 'copy',
  icon: Copy,
  id: 'assistant-thread.copy-title',
  label: 'Copy Thread Title',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyThreadValue(services, target.title, 'Thread title copied'),
};

const copyThreadId: ContextAction<AssistantThreadTargetKind> = {
  appliesTo: ['assistant-thread', 'assistant-thread-tab'],
  group: 'copy',
  icon: Copy,
  id: 'assistant-thread.copy-id',
  label: 'Copy Thread ID',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyThreadValue(services, target.id, 'Thread ID copied'),
};

export const copyThreadTitleAction = defineContextAction(copyThreadTitle);
export const copyThreadIdAction = defineContextAction(copyThreadId);

export const assistantThreadActions: readonly AnyContextAction[] = [
  copyThreadTitleAction,
  copyThreadIdAction,
];
