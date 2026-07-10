import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import {
  copyFullPathAction,
  copyNameAction,
  copyRelativePathAction,
  copySelectionAction,
  fileEntryActions,
  openInDefaultAppAction,
  revealInOsAction,
} from '../file-entry-actions';

const desktopTarget: ContextTarget = {
  absolutePath: '/root/docs/notes.md',
  entryType: 'file',
  kind: 'file-entry',
  name: 'notes.md',
  relativePath: 'docs/notes.md',
  rootFolderId: '/root',
};

const viewerTarget: ContextTarget = {
  absolutePath: '/root/docs/notes.md',
  kind: 'file-viewer',
  name: 'notes.md',
  relativePath: 'docs/notes.md',
  rootFolderId: 'root-id',
  selectionText: '  selected\ntext  ',
  tabId: 'root-id|@|/root/docs/notes.md',
  viewMode: 'source',
};

function makeServices() {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    platformFs: {
      openPath: vi.fn().mockResolvedValue({ ok: true }),
      showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
    },
  } satisfies ActionServices;
}

describe('fileEntryActions', () => {
  it('exports the reusable file actions for trees, tabs, and viewers', () => {
    expect(fileEntryActions.map((action) => action.id)).toEqual([
      'file.copy-selection',
      'file.copy-name',
      'file.copy-relative-path',
      'file.copy-full-path',
      'file.open-in-default-app',
      'file.reveal-in-os',
    ]);
  });

  it('copies the exact event-time viewer selection without trimming it', async () => {
    const services = makeServices();
    const outcome = await copySelectionAction.run(viewerTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('  selected\ntext  ');
    expect(outcome).toEqual({ message: 'Selection copied', ok: true });
    expect(copySelectionAction.shortcut).toEqual({ key: 'C', modifiers: ['primary'] });
  });

  it('keeps Copy visible but disabled when the viewer selection is collapsed', () => {
    expect(copySelectionAction.isEnabled?.({ ...viewerTarget, selectionText: null })).toBe(false);
  });

  it('copy-name writes the file name', async () => {
    const services = makeServices();
    const outcome = await copyNameAction.run(desktopTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('notes.md');
    expect(outcome).toEqual({ message: 'Name copied', ok: true });
  });

  it('copy-relative-path writes the relative path', async () => {
    const services = makeServices();
    await copyRelativePathAction.run(desktopTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('docs/notes.md');
  });

  it('hides Copy Relative Path when root identity cannot be resolved to a path', () => {
    expect(copyRelativePathAction.isVisible?.({ ...desktopTarget, relativePath: null })).toBe(
      false
    );
  });

  it('copy-full-path writes the absolute path and is hidden without one', async () => {
    const services = makeServices();
    await copyFullPathAction.run(desktopTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('/root/docs/notes.md');
    expect(copyFullPathAction.isVisible?.({ ...desktopTarget, absolutePath: null })).toBe(false);
  });

  it('reveal calls showItemInFolder and fails loudly without the service', async () => {
    const services = makeServices();
    await revealInOsAction.run(desktopTarget, services);
    expect(services.platformFs.showItemInFolder).toHaveBeenCalledWith('/root/docs/notes.md');

    const outcome = await revealInOsAction.run(desktopTarget, { clipboard: services.clipboard });
    expect(outcome.ok).toBe(false);
  });

  it('opens the absolute path in the default app through the platform service', async () => {
    const services = makeServices();
    const outcome = await openInDefaultAppAction.run(desktopTarget, services);
    expect(services.platformFs.openPath).toHaveBeenCalledWith('/root/docs/notes.md');
    expect(outcome).toEqual({ ok: true });
  });

  it('clipboard failures propagate as the action outcome', async () => {
    const services = makeServices();
    services.clipboard.writeText.mockResolvedValue({ error: 'denied', ok: false });
    const outcome = await copyNameAction.run(desktopTarget, services);
    expect(outcome).toEqual({ error: 'denied', ok: false });
  });
});
