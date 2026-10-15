// @vitest-environment node
import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import {
  collectionActions,
  copyContentAction,
  copyFileNameAction,
  copyFilePathAction,
  copyIdAction,
} from '../collection-actions';

function makeServices() {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
  } satisfies ActionServices;
}

describe('collection actions', () => {
  const chunkTarget: ContextTarget = { content: 'hello world', id: 'c-1', kind: 'chunk' };
  const fileTarget: ContextTarget = {
    id: 'file-1',
    kind: 'collection-file',
    name: 'notes.md',
    path: 'docs/notes.md',
  };
  const fileTargetNoPath: ContextTarget = {
    id: 'file-2',
    kind: 'collection-file',
    name: 'unnamed.md',
    path: null,
  };

  it('exports copy-name, copy-path, copy-id and copy-content in array order', () => {
    expect(collectionActions.map((action) => action.id)).toEqual([
      'collection.copy-name',
      'collection.copy-path',
      'collection.copy-id',
      'collection.copy-content',
    ]);
  });

  it('copy-name writes file name with Name copied', async () => {
    const services = makeServices();
    const outcome = await copyFileNameAction.run(fileTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('notes.md');
    expect(outcome).toEqual({ message: 'Name copied', ok: true });
  });

  it('copy-path writes file path with Path copied', async () => {
    const services = makeServices();
    const outcome = await copyFilePathAction.run(fileTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('docs/notes.md');
    expect(outcome).toEqual({ message: 'Path copied', ok: true });
  });

  it('copy-path isVisible is false when path is null', () => {
    expect(copyFilePathAction.isVisible?.(fileTargetNoPath)).toBe(false);
    expect(copyFilePathAction.isVisible?.(fileTarget)).toBe(true);
  });

  it('copy-path run returns ok:false when path is null', async () => {
    const services = makeServices();
    const outcome = await copyFilePathAction.run(fileTargetNoPath, services);
    expect(outcome).toEqual({ error: 'No recorded path for this file', ok: false });
    expect(services.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('copy-id applies to every collection target kind and writes the id', async () => {
    expect(copyIdAction.appliesTo).toEqual(['collection', 'collection-file', 'chunk', 'embedding']);
    const services = makeServices();
    const outcome = await copyIdAction.run(chunkTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('c-1');
    expect(outcome).toEqual({ message: 'ID copied', ok: true });
  });

  it('copy-content writes chunk content', async () => {
    const services = makeServices();
    await copyContentAction.run(chunkTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('hello world');
  });

  it('copy-content is hidden for chunks with empty content', () => {
    const emptyChunk: ContextTarget = { content: '', id: 'c-2', kind: 'chunk' };
    expect(copyContentAction.isVisible?.(emptyChunk)).toBe(false);
    expect(copyContentAction.isVisible?.(chunkTarget)).toBe(true);
  });
});
