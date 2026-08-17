import {
  parseFileMentionDirectives,
  serializeFileMentionDirective,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { buildFileMentionAdapter, type FileMention } from '../file-mentions';

const FILES: FileMention[] = [
  { id: 'r1::src/app.ts', label: 'app.ts', path: 'src/app.ts', rootLabel: 'workspace' },
  { id: 'r1::src/util.ts', label: 'util.ts', path: 'src/util.ts', rootLabel: 'workspace' },
];

describe('buildFileMentionAdapter', () => {
  it('exposes no categories (flat search-mode list, like slash commands)', () => {
    const adapter = buildFileMentionAdapter(FILES, vi.fn());
    expect(adapter.categories()).toEqual([]);
  });

  it('returns the file items as file-typed trigger items via search()', () => {
    const adapter = buildFileMentionAdapter(FILES, vi.fn());
    const items = adapter.search?.('') ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'r1::src/app.ts', label: 'app.ts', type: 'file' });
  });

  it('notifies the query callback when search() is called (drives async load)', async () => {
    const onQuery = vi.fn();
    const adapter = buildFileMentionAdapter(FILES, onQuery);
    adapter.search?.('ap');
    // The notify is deferred to a microtask (search runs in the library's render
    // pass, so it must not synchronously trigger app-shell setState). Flush it.
    await Promise.resolve();
    expect(onQuery).toHaveBeenCalledWith('ap');
  });

  it('returns the provided items verbatim (filtering happens upstream in the DB query)', () => {
    // The DB live-query already filtered by the typed query; the adapter must NOT
    // re-filter, or it would hide rows whose basename does not contain the path
    // fragment the user typed.
    const adapter = buildFileMentionAdapter(FILES, vi.fn());
    expect(adapter.search?.('zzz')).toHaveLength(2);
  });
});

describe('directive serialization parity (contract <-> server parser)', () => {
  // The library's MentionRoot serializes a selected item via the default
  // formatter (`:type[label]{name=id}`); our contract serializer mirrors that
  // exact format. The end-to-end behaviour test proves the library inserts the
  // identical string; here we lock that each file item round-trips through the
  // SAME server-side parser the desktop assistant server uses.
  it('each file item serializes to a directive the server parser round-trips', () => {
    const adapter = buildFileMentionAdapter(FILES, vi.fn());
    const items = adapter.search?.('') ?? [];
    for (const item of items) {
      const directive = serializeFileMentionDirective({ id: item.id, label: item.label });
      const parsed = parseFileMentionDirectives(`see ${directive}`);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ id: item.id, label: item.label });
    }
  });
});
