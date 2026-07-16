import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type FakeFileHandle, fakeNote } from '../../__tests__/support/fake-handles';
import type { VaultNoteNode } from '../../core/types';
import { useNoteEditor } from '../use-note-editor';

function noteFor(handle: FakeFileHandle, id = `r1:${handle.name}`): VaultNoteNode {
  return {
    handle,
    id,
    lastModified: handle.state.lastModified,
    name: handle.name,
    pathSegments: [handle.name],
    rootId: 'r1',
    size: handle.state.content.length,
    type: 'note',
  };
}

describe('useNoteEditor', () => {
  it('seeds the draft from disk content on beginEdit and saves on demand', async () => {
    const handle = fakeNote('a.md', { content: 'original' });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useNoteEditor({ autosaveMs: 0, diskContent: 'original', note: noteFor(handle), onSaved })
    );

    act(() => result.current.beginEdit());
    expect(result.current.editing).toBe(true);
    expect(result.current.draft).toBe('original');

    act(() => result.current.updateDraft('edited body'));
    expect(result.current.saveState).toBe('dirty');
    await act(() => result.current.save());

    expect(handle.state.content).toBe('edited body');
    expect(result.current.saveState).toBe('saved');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('autosaves after the debounce window', async () => {
    const handle = fakeNote('a.md', { content: 'v1' });
    const { result } = renderHook(() =>
      useNoteEditor({ autosaveMs: 15, diskContent: 'v1', note: noteFor(handle), onSaved: vi.fn() })
    );

    act(() => result.current.beginEdit());
    act(() => result.current.updateDraft('v2'));

    await waitFor(() => {
      expect(handle.state.content).toBe('v2');
    });
    expect(result.current.saveState).toBe('saved');
  });

  it('surfaces save failures and keeps the draft', async () => {
    const handle = fakeNote('a.md', { content: 'v1' });
    handle.createWritable = () =>
      Promise.reject(new DOMException('write access lost', 'NotAllowedError'));
    const { result } = renderHook(() =>
      useNoteEditor({ autosaveMs: 0, diskContent: 'v1', note: noteFor(handle), onSaved: vi.fn() })
    );

    act(() => result.current.beginEdit());
    act(() => result.current.updateDraft('unsaved work'));
    await act(() => result.current.save());

    expect(result.current.saveState).toBe('error');
    expect(result.current.error).toMatch(/write access lost/);
    expect(result.current.draft).toBe('unsaved work');
  });

  it('adopts external disk changes when the draft is clean, flags them when dirty', async () => {
    const handle = fakeNote('a.md', { content: 'v1' });
    const note = noteFor(handle);
    const { rerender, result } = renderHook(
      ({ diskContent }: { diskContent: string }) =>
        useNoteEditor({ autosaveMs: 0, diskContent, note, onSaved: vi.fn() }),
      { initialProps: { diskContent: 'v1' } }
    );
    act(() => result.current.beginEdit());

    // Clean buffer: external edit is adopted.
    rerender({ diskContent: 'external v2' });
    expect(result.current.draft).toBe('external v2');
    expect(result.current.externallyChanged).toBe(false);

    // Dirty buffer: external edit is flagged, draft preserved.
    act(() => result.current.updateDraft('my unsaved work'));
    rerender({ diskContent: 'external v3' });
    expect(result.current.draft).toBe('my unsaved work');
    expect(result.current.externallyChanged).toBe(true);
  });

  it('flushes a dirty draft when the note switches and exits editing', async () => {
    const first = fakeNote('a.md', { content: 'a1' });
    const second = fakeNote('b.md', { content: 'b1' });
    const { rerender, result } = renderHook(
      ({ note, diskContent }: { note: VaultNoteNode; diskContent: string }) =>
        useNoteEditor({ autosaveMs: 60_000, diskContent, note, onSaved: vi.fn() }),
      { initialProps: { diskContent: 'a1', note: noteFor(first) } }
    );
    act(() => result.current.beginEdit());
    act(() => result.current.updateDraft('a1 with unsaved edits'));

    rerender({ diskContent: 'b1', note: noteFor(second) });

    await waitFor(() => {
      expect(first.state.content).toBe('a1 with unsaved edits');
    });
    expect(result.current.editing).toBe(false);
  });

  it('endEdit flushes pending changes before returning to preview', async () => {
    const handle = fakeNote('a.md', { content: 'v1' });
    const { result } = renderHook(() =>
      useNoteEditor({
        autosaveMs: 60_000,
        diskContent: 'v1',
        note: noteFor(handle),
        onSaved: vi.fn(),
      })
    );
    act(() => result.current.beginEdit());
    act(() => result.current.updateDraft('final'));

    await act(() => result.current.endEdit());

    expect(handle.state.content).toBe('final');
    expect(result.current.editing).toBe(false);
  });
});
