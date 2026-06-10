import {
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  defineContextAction,
} from '@brainstrike/context-actions';
import { Copy } from 'lucide-react';

async function copyToClipboard(
  services: ActionServices,
  text: string,
  successMessage: string
): Promise<ActionOutcome> {
  if (!services.clipboard) {
    return { ok: false, error: 'Clipboard service unavailable' };
  }
  const outcome = await services.clipboard.writeText(text);
  return outcome.ok ? { ok: true, message: successMessage } : outcome;
}

export const copyIdAction = defineContextAction({
  id: 'collection.copy-id',
  label: 'Copy ID',
  icon: Copy,
  group: 'copy',
  appliesTo: ['collection', 'collection-file', 'chunk', 'embedding'] as const,
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => copyToClipboard(services, target.id, 'ID copied'),
});

export const copyContentAction = defineContextAction({
  id: 'collection.copy-content',
  label: 'Copy Content',
  icon: Copy,
  group: 'copy',
  appliesTo: ['chunk'] as const,
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => copyToClipboard(services, target.content, 'Content copied'),
});

export const collectionActions: readonly AnyContextAction[] = [copyIdAction, copyContentAction];
