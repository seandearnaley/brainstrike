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
    return { error: 'Clipboard service unavailable', ok: false };
  }
  const outcome = await services.clipboard.writeText(text);
  return outcome.ok ? { message: successMessage, ok: true } : outcome;
}

export const copyFileNameAction = defineContextAction({
  appliesTo: ['collection-file'] as const,
  group: 'copy',
  icon: Copy,
  id: 'collection.copy-name',
  label: 'Copy Name',
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => copyToClipboard(services, target.name, 'Name copied'),
});

export const copyFilePathAction = defineContextAction({
  appliesTo: ['collection-file'] as const,
  group: 'copy',
  icon: Copy,
  id: 'collection.copy-path',
  isVisible: (target) => target.path !== null,
  // The recorded path's shape depends on the import source (web imports store
  // root-relative paths; desktop imports store absolute paths), so the label
  // says "Path" rather than promising relativity.
  label: 'Copy Path',
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => {
    if (target.path === null) {
      return Promise.resolve<ActionOutcome>({
        error: 'No recorded path for this file',
        ok: false,
      });
    }
    return copyToClipboard(services, target.path, 'Path copied');
  },
});

export const copyIdAction = defineContextAction({
  appliesTo: ['collection', 'collection-file', 'chunk', 'embedding'] as const,
  group: 'copy',
  icon: Copy,
  id: 'collection.copy-id',
  label: 'Copy ID',
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => copyToClipboard(services, target.id, 'ID copied'),
});

export const copyContentAction = defineContextAction({
  appliesTo: ['chunk'] as const,
  group: 'copy',
  icon: Copy,
  id: 'collection.copy-content',
  // Data-shaped gating: a chunk with no materialized content has nothing to
  // copy — hide the item rather than copying an empty string.
  isVisible: (target) => target.content.length > 0,
  label: 'Copy Content',
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => copyToClipboard(services, target.content, 'Content copied'),
});

export const collectionActions: readonly AnyContextAction[] = [
  copyFileNameAction,
  copyFilePathAction,
  copyIdAction,
  copyContentAction,
];
