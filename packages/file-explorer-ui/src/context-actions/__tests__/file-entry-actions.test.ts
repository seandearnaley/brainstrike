import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import {
  copyFullPathAction,
  copyNameAction,
  copyRelativePathAction,
  fileEntryActions,
  revealInOsAction,
} from '../file-entry-actions';

const desktopTarget: ContextTarget = {
  kind: 'file-entry',
  name: 'notes.md',
  relativePath: 'docs/notes.md',
  absolutePath: '/root/docs/notes.md',
  entryType: 'file',
  rootFolderId: '/root',
};

function makeServices() {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    platformFs: {
      showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
      openPath: vi.fn().mockResolvedValue({ ok: true }),
    },
  } satisfies ActionServices;
}

describe('fileEntryActions', () => {
  it('exports the four global actions', () => {
    expect(fileEntryActions.map((action) => action.id)).toEqual([
      'file.copy-name',
      'file.copy-relative-path',
      'file.copy-full-path',
      'file.reveal-in-os',
    ]);
  });

  it('copy-name writes the file name', async () => {
    const services = makeServices();
    const outcome = await copyNameAction.run(desktopTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('notes.md');
    expect(outcome).toEqual({ ok: true, message: 'Name copied' });
  });

  it('copy-relative-path writes the relative path', async () => {
    const services = makeServices();
    await copyRelativePathAction.run(desktopTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('docs/notes.md');
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

  it('clipboard failures propagate as the action outcome', async () => {
    const services = makeServices();
    services.clipboard.writeText.mockResolvedValue({ ok: false, error: 'denied' });
    const outcome = await copyNameAction.run(desktopTarget, services);
    expect(outcome).toEqual({ ok: false, error: 'denied' });
  });
});
