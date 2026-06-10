import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import { collectionActions, copyContentAction, copyIdAction } from '../collection-actions';
import { browserNodeToTarget } from '../collection-target';

function makeServices() {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
  } satisfies ActionServices;
}

describe('browserNodeToTarget', () => {
  it('maps a collection node', () => {
    expect(
      browserNodeToTarget({ nodeType: 'collection', originalId: 'set-1', name: 'My Docs' })
    ).toEqual({ kind: 'collection', id: 'set-1', name: 'My Docs' });
  });

  it('maps a file node with its recorded path', () => {
    expect(
      browserNodeToTarget({
        nodeType: 'file',
        originalId: 'file-1',
        name: 'notes.md',
        path: 'docs/notes.md',
      })
    ).toEqual({ kind: 'collection-file', id: 'file-1', name: 'notes.md', path: 'docs/notes.md' });
  });

  it('maps a chunk node with content', () => {
    expect(
      browserNodeToTarget({ nodeType: 'chunk', originalId: 'c-1', content: 'hello world' })
    ).toEqual({ kind: 'chunk', id: 'c-1', content: 'hello world' });
  });

  it('maps an embedding node', () => {
    expect(
      browserNodeToTarget({ nodeType: 'embedding', originalId: 'e-1', vectorId: 'v-1' })
    ).toEqual({ kind: 'embedding', id: 'e-1', vectorId: 'v-1' });
  });

  it('returns null for group headers', () => {
    expect(browserNodeToTarget({ nodeType: 'group', originalId: 'g-1' })).toBeNull();
  });
});

describe('collection actions', () => {
  const chunkTarget: ContextTarget = { kind: 'chunk', id: 'c-1', content: 'hello world' };

  it('exports copy-id and copy-content', () => {
    expect(collectionActions.map((action) => action.id)).toEqual([
      'collection.copy-id',
      'collection.copy-content',
    ]);
  });

  it('copy-id applies to all collection-browser kinds and writes the id', async () => {
    expect(copyIdAction.appliesTo).toEqual(['collection', 'collection-file', 'chunk', 'embedding']);
    const services = makeServices();
    const outcome = await copyIdAction.run(chunkTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('c-1');
    expect(outcome).toEqual({ ok: true, message: 'ID copied' });
  });

  it('copy-content writes chunk content', async () => {
    const services = makeServices();
    await copyContentAction.run(chunkTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('hello world');
  });
});
