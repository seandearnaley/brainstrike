import type { ChangedFileEntry, GitResult, StructuredFileDiff } from '@brainstrike/types';
import type { DiffViewSource } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changedFileKey, useChangesStore } from '../changes-store';
import { ChangesetDiffPane } from '../ui/changeset-diff-pane';

// Stub the heavy CodeMirror DiffView (covered by its own suite).
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    DiffView: (props: { filename?: string; source: DiffViewSource }) => (
      <div
        data-filename={props.filename}
        data-source-kind={props.source.kind}
        data-testid="diff-view-stub"
      />
    ),
  };
});

/** Synchronously reports every observed target as intersecting, so every
 * card in the pane loads immediately without simulating real scrolling. */
class ImmediateIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds: readonly number[] = [];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }

  unobserve(): void {
    // no-op
  }

  disconnect(): void {
    // no-op
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function makeEntry(overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return {
    additions: 1,
    deletions: 0,
    path: 'src/a.ts',
    repositoryRoot: '/repo',
    revertible: true,
    rootId: 'root-1',
    status: 'modified',
    worktreePath: '/repo',
    ...overrides,
  };
}

function makeFullDiff(path: string): StructuredFileDiff {
  return {
    additions: 1,
    content: { kind: 'full', newContent: 'new\n', oldContent: 'old\n' },
    deletions: 0,
    hunks: [],
    path,
    status: 'modified',
  };
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);
  useChangesStore.getState().clearSelection();
});

afterEach(() => {
  vi.unstubAllGlobals();
  useChangesStore.getState().clearSelection();
});

describe('ChangesetDiffPane', () => {
  it('renders every file when nothing is explicitly selected', async () => {
    const files = [makeEntry({ path: 'src/a.ts' }), makeEntry({ path: 'src/b.ts' })];
    const loadFileDiff = vi.fn(
      async (path: string): Promise<GitResult<StructuredFileDiff>> => ({
        ok: true,
        value: makeFullDiff(path),
      })
    );

    render(
      <ChangesetDiffPane
        changesetKey="test-changeset"
        changesetKind="git-scope"
        files={files}
        loadFileDiff={loadFileDiff}
      />
    );

    const cards = await screen.findAllByTestId('changeset-file-diff-card');
    expect(cards).toHaveLength(2);
  });

  it('renders only the selected files, in changeset order', async () => {
    const files = [
      makeEntry({ path: 'src/a.ts' }),
      makeEntry({ path: 'src/b.ts' }),
      makeEntry({ path: 'src/c.ts' }),
    ];
    useChangesStore
      .getState()
      .setSelectedFileKeys(
        new Set([
          changedFileKey(files[2] as ChangedFileEntry),
          changedFileKey(files[0] as ChangedFileEntry),
        ])
      );
    const loadFileDiff = vi.fn(
      async (path: string): Promise<GitResult<StructuredFileDiff>> => ({
        ok: true,
        value: makeFullDiff(path),
      })
    );

    render(
      <ChangesetDiffPane
        changesetKey="test-changeset"
        changesetKind="git-scope"
        files={files}
        loadFileDiff={loadFileDiff}
      />
    );

    const cards = await screen.findAllByTestId('changeset-file-diff-card');
    expect(cards).toHaveLength(2);
    // Changeset order (a.ts before c.ts), not selection-insertion order.
    expect(within(cards[0] as HTMLElement).getByText('src/a.ts')).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText('src/c.ts')).toBeInTheDocument();
    expect(screen.queryByText('src/b.ts')).not.toBeInTheDocument();
  });

  it('does not let one file error blank the rest of the pane', async () => {
    const files = [makeEntry({ path: 'src/a.ts' }), makeEntry({ path: 'src/b.ts' })];
    const loadFileDiff = vi.fn(async (path: string): Promise<GitResult<StructuredFileDiff>> => {
      if (path === 'src/a.ts') {
        return { error: 'boom', ok: false };
      }
      return { ok: true, value: makeFullDiff(path) };
    });

    render(
      <ChangesetDiffPane
        changesetKey="test-changeset"
        changesetKind="git-scope"
        files={files}
        loadFileDiff={loadFileDiff}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('changeset-file-diff-card-error')).toHaveTextContent('boom');
    });
    expect(await screen.findByTestId('diff-view-stub')).toBeInTheDocument();
  });

  it('distinguishes an empty changeset from an empty selection', async () => {
    const loadFileDiff = vi.fn<() => Promise<GitResult<StructuredFileDiff>>>();

    const { rerender } = render(
      <ChangesetDiffPane
        changesetKey="test-changeset"
        changesetKind="git-scope"
        files={[]}
        loadFileDiff={loadFileDiff}
      />
    );

    expect(screen.getByTestId('changeset-diff-pane-empty-changeset')).toHaveTextContent(
      'This changeset has no files.'
    );
    expect(screen.queryByTestId('changeset-diff-pane-empty-selection')).not.toBeInTheDocument();

    const files = [makeEntry({ path: 'src/a.ts' })];
    // A selection that names no file in the current list ⇒ "the selection
    // matches nothing", a DIFFERENT fact from "changeset has no files". The
    // copy deliberately does NOT say "no files selected": a selection carried
    // over from a previous changeset is non-empty, and telling the user they
    // selected nothing while the tree shows unchecked boxes is the dishonest
    // state this pane exists to avoid.
    useChangesStore.getState().setSelectedFileKeys(new Set(['nonexistent-key']));
    rerender(
      <ChangesetDiffPane
        changesetKey="test-changeset"
        changesetKind="git-scope"
        files={files}
        loadFileDiff={loadFileDiff}
      />
    );

    expect(screen.getByTestId('changeset-diff-pane-empty-selection')).toHaveTextContent(
      'No files match the current selection'
    );
    expect(screen.queryByTestId('changeset-diff-pane-empty-changeset')).not.toBeInTheDocument();
  });
});
