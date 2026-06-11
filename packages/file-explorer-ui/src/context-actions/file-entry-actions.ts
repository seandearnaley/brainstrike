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
    return { ok: false, error: 'Clipboard service unavailable' };
  }
  const outcome = await services.clipboard.writeText(text);
  return outcome.ok ? { ok: true, message: successMessage } : outcome;
}

function revealLabel(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  return platform.toLowerCase().startsWith('mac') ? 'Reveal in Finder' : 'Reveal in File Explorer';
}

const copyName: ContextAction<'file-entry'> = {
  id: 'file.copy-name',
  label: 'Copy Name',
  icon: Copy,
  group: 'copy',
  appliesTo: ['file-entry'],
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyToClipboard(services, target.name, 'Name copied'),
};

const copyRelativePath: ContextAction<'file-entry'> = {
  id: 'file.copy-relative-path',
  label: 'Copy Relative Path',
  icon: Copy,
  group: 'copy',
  appliesTo: ['file-entry'],
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyToClipboard(services, target.relativePath, 'Relative path copied'),
};

const copyFullPath: ContextAction<'file-entry'> = {
  id: 'file.copy-full-path',
  label: 'Copy Full Path',
  icon: Copy,
  group: 'copy',
  appliesTo: ['file-entry'],
  requiredCapabilities: ['clipboard'],
  isVisible: (target) => target.absolutePath !== null,
  run: (target, services) => {
    if (target.absolutePath === null) {
      return Promise.resolve<ActionOutcome>({
        ok: false,
        error: 'No absolute path available for this entry',
      });
    }
    return copyToClipboard(services, target.absolutePath, 'Full path copied');
  },
};

const revealInOs: ContextAction<'file-entry'> = {
  id: 'file.reveal-in-os',
  label: () => revealLabel(),
  icon: FolderOpen,
  group: 'navigate',
  appliesTo: ['file-entry'],
  requiredCapabilities: ['fs.reveal'],
  isVisible: (target) => target.absolutePath !== null,
  run: async (target: FileEntryTarget, services) => {
    if (!services.platformFs) {
      return { ok: false, error: 'Platform file-system service unavailable' };
    }
    if (target.absolutePath === null) {
      return { ok: false, error: 'No absolute path available for this entry' };
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
