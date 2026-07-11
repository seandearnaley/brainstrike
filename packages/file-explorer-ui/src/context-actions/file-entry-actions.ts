import {
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  type ContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import { Copy, ExternalLink, FolderOpen } from 'lucide-react';

type FileTargetKind = 'file-entry' | 'workspace-file-tab' | 'file-viewer';
type FileTarget = TargetOf<FileTargetKind>;

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

const copySelection: ContextAction<'file-viewer'> = {
  appliesTo: ['file-viewer'],
  group: 'copy',
  icon: Copy,
  id: 'file.copy-selection',
  isEnabled: (target) => target.selectionText !== null,
  label: 'Copy',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => {
    if (target.selectionText === null) {
      return Promise.resolve({ error: 'No text selected', ok: false });
    }
    return copyToClipboard(services, target.selectionText, 'Selection copied');
  },
  shortcut: { key: 'C', modifiers: ['primary'] },
};

const copyName: ContextAction<FileTargetKind> = {
  appliesTo: ['file-entry', 'workspace-file-tab', 'file-viewer'],
  group: 'copy',
  icon: Copy,
  id: 'file.copy-name',
  label: 'Copy Name',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyToClipboard(services, target.name, 'Name copied'),
};

const copyRelativePath: ContextAction<FileTargetKind> = {
  appliesTo: ['file-entry', 'workspace-file-tab', 'file-viewer'],
  group: 'copy',
  icon: Copy,
  id: 'file.copy-relative-path',
  isVisible: (target) => target.relativePath !== null,
  label: 'Copy Relative Path',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => {
    if (target.relativePath === null) {
      return Promise.resolve({ error: 'No relative path available for this entry', ok: false });
    }
    return copyToClipboard(services, target.relativePath, 'Relative path copied');
  },
};

const copyFullPath: ContextAction<FileTargetKind> = {
  appliesTo: ['file-entry', 'workspace-file-tab', 'file-viewer'],
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

const openInDefaultApp: ContextAction<FileTargetKind> = {
  appliesTo: ['file-entry', 'workspace-file-tab', 'file-viewer'],
  group: 'navigate',
  icon: ExternalLink,
  id: 'file.open-in-default-app',
  isVisible: (target) => target.absolutePath !== null,
  label: 'Open in Default App',
  requiredCapabilities: ['fs.openPath'],
  run: async (target: FileTarget, services) => {
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    if (target.absolutePath === null) {
      return { error: 'No absolute path available for this entry', ok: false };
    }
    return await services.platformFs.openPath(target.absolutePath);
  },
};

const revealInOs: ContextAction<FileTargetKind> = {
  appliesTo: ['file-entry', 'workspace-file-tab', 'file-viewer'],
  group: 'navigate',
  icon: FolderOpen,
  id: 'file.reveal-in-os',
  isVisible: (target) => target.absolutePath !== null,
  label: () => revealLabel(),
  requiredCapabilities: ['fs.reveal'],
  run: async (target: FileTarget, services) => {
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    if (target.absolutePath === null) {
      return { error: 'No absolute path available for this entry', ok: false };
    }
    return await services.platformFs.showItemInFolder(target.absolutePath);
  },
};

export const copySelectionAction = defineContextAction(copySelection);
export const copyNameAction = defineContextAction(copyName);
export const copyRelativePathAction = defineContextAction(copyRelativePath);
export const copyFullPathAction = defineContextAction(copyFullPath);
export const openInDefaultAppAction = defineContextAction(openInDefaultApp);
export const revealInOsAction = defineContextAction(revealInOs);

export const fileEntryActions: readonly AnyContextAction[] = [
  copySelectionAction,
  copyNameAction,
  copyRelativePathAction,
  copyFullPathAction,
  openInDefaultAppAction,
  revealInOsAction,
];
