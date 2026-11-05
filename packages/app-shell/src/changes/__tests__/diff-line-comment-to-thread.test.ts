import type { ChangedFileEntry } from '@brainstrike/types';
import type { DiffComment } from '@brainstrike/ui';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../../assistant-composer-command-store';
import { formatDiffLineComment, useDiffCommentsToThread } from '../diff-line-comment-to-thread';

const thread = vi.hoisted(() => ({ active: 'thread-1' as string | null }));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/assistant-data', () => ({
  useActiveAssistantThreadId: () => thread.active,
}));
vi.mock('@brainstrike/ui/use-toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui/use-toast')>()),
  toast,
}));

const comment = {
  endLine: 12,
  lines: ['const answer = 42;'],
  side: 'additions',
  startLine: 12,
  text: 'Explain why it is 42.',
} as const;

describe('formatDiffLineComment', () => {
  it('names the file, its folder and the line, then quotes it above the comment', () => {
    expect(
      formatDiffLineComment({ comment, entry: { path: 'src/answer.ts' }, rootLabel: 'app' })
    ).toBe(
      [
        '`src/answer.ts` in app, line 12:',
        '```',
        'const answer = 42;',
        '```',
        'Explain why it is 42.',
      ].join('\n')
    );
  });

  it('gives a range its first and last line', () => {
    expect(
      formatDiffLineComment({
        comment: { ...comment, endLine: 14, lines: ['a', 'b', 'c'] },
        entry: { path: 'src/answer.ts' },
      })
    ).toMatch(/^`src\/answer\.ts`, lines 12–14:\n```\na\nb\nc\n```\n/u);
  });

  it('puts an old-side comment on the old version, under a rename its old path', () => {
    expect(
      formatDiffLineComment({
        comment: { ...comment, side: 'deletions' },
        entry: { oldPath: 'src/old-answer.ts', path: 'src/answer.ts' },
      })
    ).toMatch(/^`src\/old-answer\.ts`, line 12 of the old version:\n/u);
  });

  it('fences quoted lines that hold a fence of their own', () => {
    const text = formatDiffLineComment({
      comment: { ...comment, lines: ['```ts', 'x', '```'] },
      entry: { path: 'README.md' },
    });
    expect(text).toContain('\n````\n```ts\nx\n```\n````\n');
  });
});

describe('useDiffCommentsToThread', () => {
  const answer: ChangedFileEntry = {
    actions: [],
    additions: 1,
    deletions: 1,
    patch: null,
    path: 'src/answer.ts',
    repositoryRoot: '/repo',
    revision: 'r1',
    rootId: 'root-app',
    status: 'modified',
    worktreePath: '/repo',
  };
  const renamed: ChangedFileEntry = {
    ...answer,
    oldPath: 'src/old-name.ts',
    path: 'src/new-name.ts',
    rootId: null,
    status: 'renamed',
  };
  const drafts: { comment: DiffComment; entry: ChangedFileEntry }[] = [
    { comment: { ...comment, fileId: 'answer', id: 'c-1' }, entry: answer },
    {
      comment: {
        endLine: 3,
        fileId: 'renamed',
        id: 'c-2',
        lines: ['old line'],
        side: 'deletions',
        startLine: 3,
        text: 'Why did this go?',
      },
      entry: renamed,
    },
  ];
  const labels = new Map([['root-app', 'app']]);

  beforeEach(() => {
    thread.active = 'thread-1';
    toast.mockClear();
    useAssistantComposerCommandStore.getState().reset();
  });

  it("adds every comment to the active thread's message at once, a blank line apart", () => {
    const { result } = renderHook(() => useDiffCommentsToThread(labels));

    expect(result.current(drafts)).toBe(true);

    const commands = useAssistantComposerCommandStore.getState().commandsByThreadId['thread-1'];
    expect(commands).toHaveLength(1);
    expect(commands?.[0]?.mode).toBe('append');
    expect(commands?.[0]?.text).toBe(
      [
        '`src/answer.ts` in app, line 12:',
        '```',
        'const answer = 42;',
        '```',
        'Explain why it is 42.',
        '',
        '`src/old-name.ts`, line 3 of the old version:',
        '```',
        'old line',
        '```',
        'Why did this go?',
      ].join('\n')
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it('says there is no thread and keeps the drafts when none is active', () => {
    thread.active = null;
    const { result } = renderHook(() => useDiffCommentsToThread(labels));

    expect(result.current(drafts)).toBe(false);

    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'No active thread' }));
  });
});
