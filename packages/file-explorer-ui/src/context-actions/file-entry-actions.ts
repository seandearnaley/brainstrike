import {
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  type ContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import { Copy, FolderOpen } from 'lucide-react';

type FileEntryTarget = TargetOf<'file-entry'>;

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

function revealLabel(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  return platform.toLowerCase().startsWith('mac') ? 'Reveal in Finder' : 'Reveal in File Explorer';
}

const copyName: ContextAction<'file-entry'> = {
  appliesTo: ['file-entry'],
  group: 'copy',
  icon: Copy,
  id: 'file.copy-name',
  label: 'Copy Name',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyToClipboard(services, target.name, 'Name copied'),
};

const copyRelativePath: ContextAction<'file-entry'> = {
  appliesTo: ['file-entry'],
  group: 'copy',
  icon: Copy,
  id: 'file.copy-relative-path',
  label: 'Copy Relative Path',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyToClipboard(services, target.relativePath, 'Relative path copied'),
};

const copyFullPath: ContextAction<'file-entry'> = {
  appliesTo: ['file-entry'],
  group: 'copy',
  icon: Copy,
  id: 'file.copy-full-path',
  isVisible: (target) => target.absolutePath !== null,
  label: 'Copy Full Path',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => {
    if (target.absolutePath === null) {
      return Promise.resolve<ActionOutcome>({
        error: 'No absolute path available for this entry',
        ok: false,
      });
    }
    return copyToClipboard(services, target.absolutePath, 'Full path copied');
  },
};

const revealInOs: ContextAction<'file-entry'> = {
  appliesTo: ['file-entry'],
  group: 'navigate',
  icon: FolderOpen,
  id: 'file.reveal-in-os',
  isVisible: (target) => target.absolutePath !== null,
  label: () => revealLabel(),
  requiredCapabilities: ['fs.reveal'],
  run: async (target: FileEntryTarget, services) => {
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    if (target.absolutePath === null) {
      return { error: 'No absolute path available for this entry', ok: false };
    }
    return await services.platformFs.showItemInFolder(target.absolutePath);
  },
};

export const copyNameAction = defineContextAction(copyName);
export const copyRelativePathAction = defineContextAction(copyRelativePath);
export const copyFullPathAction = defineContextAction(copyFullPath);
export const revealInOsAction = defineContextAction(revealInOs);

export const fileEntryActions: readonly AnyContextAction[] = [
  copyNameAction,
  copyRelativePathAction,
  copyFullPathAction,
  revealInOsAction,
];
