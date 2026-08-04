import type { ChangedFileEntry, GitResult, StructuredFileDiff } from '@brainstrike/types';
import type { DiffViewSource } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the heavy CodeMirror DiffView (covered by its own suite) — surface the
// `source` prop so the card→DiffView wiring is asserted without mounting CM6.
// Mirrors the established pattern in `git-panel.test.tsx`.
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

import { ChangesetFileDiffCard } from '../ui/changeset-file-diff-card';

/** Synchronously reports every observed target as intersecting — lets tests
 * exercise the "load on visible" path without simulating real scrolling. */
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

/** Never fires until a test manually invokes the stored callback — used to
 * prove the card does NOT fetch before its card becomes visible. */
class ManualIntersectionObserver implements IntersectionObserver {
  static instances: ManualIntersectionObserver[] = [];
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds: readonly number[] = [];
  callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    ManualIntersectionObserver.instances.push(this);
  }

  observe(_target: Element): void {
    // Deliberately does not fire.
  }

  fire(target: Element): void {
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
    additions: 3,
    deletions: 1,
    path: 'src/foo.ts',
    repositoryRoot: '/repo',
    revertible: true,
    rootId: 'root-1',
    status: 'modified',
    worktreePath: '/repo',
    ...overrides,
  };
}

function makeFullDiff(overrides: Partial<StructuredFileDiff> = {}): StructuredFileDiff {
  return {
    additions: 3,
    content: { kind: 'full', newContent: 'new\n', oldContent: 'old\n' },
    deletions: 1,
    hunks: [],
    path: 'src/foo.ts',
    status: 'modified',
    ...overrides,
  };
}

describe('ChangesetFileDiffCard', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);
    ManualIntersectionObserver.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a journal-content-expired failure as explanatory copy, not a DiffView', async () => {
    const loadFileDiff = vi.fn(
      async (): Promise<GitResult<StructuredFileDiff>> => ({
        error:
          'journal-content-expired: before-content for checkpoint "abc" (path "src/foo.ts") is unavailable (expired retention, skipped binary/oversized capture, or a content-free rename record).',
        ok: false,
      })
    );

    render(
      <ChangesetFileDiffCard
        changesetKind="agent-run"
        entry={makeEntry()}
        loadFileDiff={loadFileDiff}
      />
    );

    expect(await screen.findByTestId('changeset-file-diff-card-journal-expired')).toHaveTextContent(
      'checkpoint content expired'
    );
    expect(screen.getByText(/evicted from/i)).toBeInTheDocument();
    expect(screen.getAllByText('src/foo.ts').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('diff-view-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('changeset-file-diff-card-error')).not.toBeInTheDocument();
  });

  it('renders the binary explanation for binary content, not an empty diff', async () => {
    const loadFileDiff = vi.fn(
      async (): Promise<GitResult<StructuredFileDiff>> => ({
        ok: true,
        value: makeFullDiff({ additions: null, content: { kind: 'binary' }, deletions: null }),
      })
    );

    render(
      <ChangesetFileDiffCard
        changesetKind="git-scope"
        entry={makeEntry({ additions: null, deletions: null })}
        loadFileDiff={loadFileDiff}
      />
    );

    expect(await screen.findByTestId('changeset-file-diff-card-binary')).toHaveTextContent(
      'Binary file — no textual diff available.'
    );
    expect(screen.queryByTestId('diff-view-stub')).not.toBeInTheDocument();
  });

  it('renders null additions as "—", never "0"', async () => {
    const loadFileDiff = vi.fn(
      async (): Promise<GitResult<StructuredFileDiff>> => ({ ok: true, value: makeFullDiff() })
    );

    render(
      <ChangesetFileDiffCard
        changesetKind="agent-run"
        entry={makeEntry({ additions: null, deletions: null })}
        loadFileDiff={loadFileDiff}
      />
    );

    const stats = await screen.findByTestId('changeset-file-diff-card-stats');
    expect(stats).toHaveTextContent('+— −—');
    expect(stats).not.toHaveTextContent('+0');
    expect(stats).not.toHaveTextContent('−0');
  });

  it('renders the message plus a Retry that calls loadFileDiff again on a generic failure', async () => {
    const user = userEvent.setup();
    const loadFileDiff = vi
      .fn<() => Promise<GitResult<StructuredFileDiff>>>()
      .mockResolvedValueOnce({ error: 'network is down', ok: false })
      .mockResolvedValueOnce({ ok: true, value: makeFullDiff() });

    render(
      <ChangesetFileDiffCard
        changesetKind="git-scope"
        entry={makeEntry()}
        loadFileDiff={loadFileDiff}
      />
    );

    expect(await screen.findByTestId('changeset-file-diff-card-error')).toHaveTextContent(
      'network is down'
    );
    expect(loadFileDiff).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(loadFileDiff).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('diff-view-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('changeset-file-diff-card-error')).not.toBeInTheDocument();
  });

  it('reaches DiffView with a structured source for full content', async () => {
    const loadFileDiff = vi.fn(
      async (): Promise<GitResult<StructuredFileDiff>> => ({ ok: true, value: makeFullDiff() })
    );

    render(
      <ChangesetFileDiffCard
        changesetKind="git-scope"
        entry={makeEntry()}
        loadFileDiff={loadFileDiff}
      />
    );

    const diffView = await screen.findByTestId('diff-view-stub');
    expect(diffView).toHaveAttribute('data-source-kind', 'structured');
    expect(diffView).toHaveAttribute('data-filename', 'src/foo.ts');
  });

  it('shows a loading affordance while the load is in flight', () => {
    const loadFileDiff = vi.fn<() => Promise<GitResult<StructuredFileDiff>>>(
      () => new Promise(() => undefined)
    );

    render(
      <ChangesetFileDiffCard
        changesetKind="git-scope"
        entry={makeEntry()}
        loadFileDiff={loadFileDiff}
      />
    );

    expect(screen.getByTestId('changeset-file-diff-card-loading')).toBeInTheDocument();
  });

  it('does not fetch until the card becomes visible', async () => {
    vi.stubGlobal('IntersectionObserver', ManualIntersectionObserver);
    const loadFileDiff = vi.fn(
      async (): Promise<GitResult<StructuredFileDiff>> => ({ ok: true, value: makeFullDiff() })
    );

    const { container } = render(
      <ChangesetFileDiffCard
        changesetKind="git-scope"
        entry={makeEntry()}
        loadFileDiff={loadFileDiff}
      />
    );

    expect(loadFileDiff).not.toHaveBeenCalled();

    const instance = ManualIntersectionObserver.instances.at(-1);
    expect(instance).toBeDefined();
    const target = container.querySelector('[data-testid="changeset-file-diff-card"]');
    expect(target).not.toBeNull();
    instance?.fire(target as Element);

    await waitFor(() => expect(loadFileDiff).toHaveBeenCalledTimes(1));
  });
});
