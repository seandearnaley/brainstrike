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

export const copyFileNameAction = defineContextAction({
  id: 'collection.copy-name',
  label: 'Copy Name',
  icon: Copy,
  group: 'copy',
  appliesTo: ['collection-file'] as const,
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => copyToClipboard(services, target.name, 'Name copied'),
});

export const copyFilePathAction = defineContextAction({
  id: 'collection.copy-path',
  // The recorded path's shape depends on the import source (web imports store
  // root-relative paths; desktop imports store absolute paths), so the label
  // says "Path" rather than promising relativity.
  label: 'Copy Path',
  icon: Copy,
  group: 'copy',
  appliesTo: ['collection-file'] as const,
  requiredCapabilities: ['clipboard'] as const,
  isVisible: (target) => target.path !== null,
  run: (target, services) => {
    if (target.path === null) {
      return Promise.resolve<ActionOutcome>({
        ok: false,
        error: 'No recorded path for this file',
      });
    }
    return copyToClipboard(services, target.path, 'Path copied');
  },
});

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
  // Data-shaped gating: a chunk with no materialized content has nothing to
  // copy — hide the item rather than copying an empty string.
  isVisible: (target) => target.content.length > 0,
  run: (target, services) => copyToClipboard(services, target.content, 'Content copied'),
});

export const collectionActions: readonly AnyContextAction[] = [
  copyFileNameAction,
  copyFilePathAction,
  copyIdAction,
  copyContentAction,
];
