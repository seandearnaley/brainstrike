import type { RuntimeData } from '@brainstrike/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceInstructionsContextMessage,
  injectWorkspaceInstructionsContext,
  MAX_CONTEXT_FILE_CHARS,
  WORKSPACE_INSTRUCTIONS_FILE_NAMES,
  type WorkspaceFileReader,
} from '../workspace-instructions-context';

const ROOT_A = { displayName: 'repo-a', path: '/abs/repo-a', rootId: 'root-a' };
const ROOT_B = { displayName: 'repo-b', path: '/abs/repo-b', rootId: 'root-b' };

/**
 * A reader backed by an in-memory `rootPath -> { requestedPath -> content }`
 * map, mirroring the real `readWorkspaceTextFile` contract (throws on a missing
 * file, returns `{ content, path, size }` on a hit).
 */
function makeReader(files: Record<string, Record<string, string>>): WorkspaceFileReader {
  return vi.fn(async ({ rootPath, requestedPath }) => {
    const content = files[rootPath]?.[requestedPath];
    if (content === undefined) {
      throw new Error(`Path "${requestedPath}" is not a file.`);
    }
    return { content, path: requestedPath, size: content.length };
  });
}

function runtime(overrides: Partial<RuntimeData> = {}): RuntimeData {
  return { provider: 'openai', workspaceRoots: [ROOT_A], ...overrides };
}

describe('buildWorkspaceInstructionsContextMessage', () => {
  it('injects a fits-the-budget context file whole, with no truncation note', async () => {
    const reader = makeReader({ '/abs/repo-a': { 'AGENTS.md': '# Conventions\nBe precise.' } });

    const message = await buildWorkspaceInstructionsContextMessage(runtime(), reader);

    expect(message).not.toBeNull();
    const text = message?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(text).toContain('repo-a/AGENTS.md');
    expect(text).toContain('Be precise.');
    expect(text).not.toContain('Truncated');
    expect(message?.role).toBe('system');
  });

  it('prefers AGENTS.md over AGENT.md over CLAUDE.md (first match wins per root)', async () => {
    expect(WORKSPACE_INSTRUCTIONS_FILE_NAMES).toEqual(['AGENTS.md', 'AGENT.md', 'CLAUDE.md']);
    const reader = makeReader({
      '/abs/repo-a': {
        'AGENT.md': 'singular',
        'AGENTS.md': 'plural',
        'CLAUDE.md': 'claude',
      },
    });

    const message = await buildWorkspaceInstructionsContextMessage(runtime(), reader);
    const text = message?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(text).toContain('plural');
    expect(text).not.toContain('singular');
    expect(text).not.toContain('claude');
  });

  it('falls back to CLAUDE.md when AGENTS.md/AGENT.md are absent', async () => {
    const reader = makeReader({ '/abs/repo-a': { 'CLAUDE.md': 'claude conventions' } });
    const message = await buildWorkspaceInstructionsContextMessage(runtime(), reader);
    const text = message?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(text).toContain('claude conventions');
    expect(text).toContain('CLAUDE.md');
  });

  it('returns null when no root has a context file', async () => {
    const reader = makeReader({ '/abs/repo-a': { 'README.md': 'nope' } });
    const message = await buildWorkspaceInstructionsContextMessage(runtime(), reader);
    expect(message).toBeNull();
  });

  it('does NOT inject an oversized file that has no per-root opt-in (no prompt note)', async () => {
    const oversized = 'x'.repeat(MAX_CONTEXT_FILE_CHARS + 5000);
    const reader = makeReader({ '/abs/repo-a': { 'AGENTS.md': oversized } });

    const message = await buildWorkspaceInstructionsContextMessage(runtime(), reader);

    // Oversized + not opted in => nothing injected, and no skip-note in the prompt.
    expect(message).toBeNull();
  });

  it('injects an oversized file TRUNCATED when the root is opted in, with an honest note', async () => {
    const oversized = `HEAD${'x'.repeat(MAX_CONTEXT_FILE_CHARS + 5000)}TAIL`;
    const reader = makeReader({ '/abs/repo-a': { 'AGENTS.md': oversized } });

    const message = await buildWorkspaceInstructionsContextMessage(
      runtime({
        workspaceInstructionsPreference: { oversizedOptInByRootId: { 'root-a': true } },
      }),
      reader
    );

    const text = message?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(text).toContain('HEAD');
    expect(text).not.toContain('TAIL');
    expect(text).toContain('Truncated');
  });

  it('skips injection entirely for the built-in local provider', async () => {
    const reader = makeReader({ '/abs/repo-a': { 'AGENTS.md': 'conventions' } });
    const message = await buildWorkspaceInstructionsContextMessage(
      runtime({ provider: 'local' }),
      reader
    );
    expect(message).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it('skips injection when the master toggle is off', async () => {
    const reader = makeReader({ '/abs/repo-a': { 'AGENTS.md': 'conventions' } });
    const message = await buildWorkspaceInstructionsContextMessage(
      runtime({ workspaceInstructionsPreference: { masterEnabled: false } }),
      reader
    );
    expect(message).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it('qualifies headings per root and injects one file per mounted root', async () => {
    const reader = makeReader({
      '/abs/repo-a': { 'AGENTS.md': 'a-conventions' },
      '/abs/repo-b': { 'CLAUDE.md': 'b-conventions' },
    });
    const message = await buildWorkspaceInstructionsContextMessage(
      runtime({ workspaceRoots: [ROOT_A, ROOT_B] }),
      reader
    );
    const text = message?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(text).toContain('repo-a/AGENTS.md');
    expect(text).toContain('a-conventions');
    expect(text).toContain('repo-b/CLAUDE.md');
    expect(text).toContain('b-conventions');
  });

  it('omits roots beyond the aggregate budget with an honest note', async () => {
    const nearBudget = 'a'.repeat(MAX_CONTEXT_FILE_CHARS); // 12K each; 4 roots ~48K
    const files: Record<string, Record<string, string>> = {};
    const roots = [];
    for (let i = 0; i < 5; i += 1) {
      const path = `/abs/repo-${i}`;
      files[path] = { 'AGENTS.md': nearBudget };
      roots.push({ displayName: `repo-${i}`, path, rootId: `root-${i}` });
    }
    const reader = makeReader(files);

    const message = await buildWorkspaceInstructionsContextMessage(
      runtime({ workspaceRoots: roots }),
      reader
    );
    const text = message?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(text).toMatch(/omitted to stay within the context budget/);
  });
});

describe('injectWorkspaceInstructionsContext', () => {
  it('prepends the context message when a file is present', async () => {
    const reader = makeReader({ '/abs/repo-a': { 'AGENTS.md': 'conventions' } });
    const messages = [
      { id: 'u1', parts: [{ text: 'hi', type: 'text' as const }], role: 'user' as const },
    ];

    const result = await injectWorkspaceInstructionsContext(messages, runtime(), reader);

    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe('system');
    expect(result[1]?.id).toBe('u1');
  });

  it('returns the original array identity when nothing is injected', async () => {
    const reader = makeReader({});
    const messages = [
      { id: 'u1', parts: [{ text: 'hi', type: 'text' as const }], role: 'user' as const },
    ];

    const result = await injectWorkspaceInstructionsContext(messages, runtime(), reader);

    expect(result).toBe(messages);
  });
});
