import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileReader } from '../workspace-instructions-context';
import { MAX_CONTEXT_FILE_CHARS } from '../workspace-instructions-context';
import { scanWorkspaceContextFiles } from '../workspace-instructions-scan';

const ROOT_A = { displayName: 'repo-a', path: '/abs/repo-a', rootId: 'root-a' };
const ROOT_B = { displayName: 'repo-b', path: '/abs/repo-b', rootId: 'root-b' };

function makeReader(files: Record<string, Record<string, string>>): WorkspaceFileReader {
  return vi.fn(async ({ rootPath, requestedPath }) => {
    const content = files[rootPath]?.[requestedPath];
    if (content === undefined) {
      // Genuinely-absent files throw ENOENT in the real reader (from `realpath`).
      throw Object.assign(new Error(`ENOENT: no such file, open '${requestedPath}'`), {
        code: 'ENOENT',
      });
    }
    return { content, path: requestedPath, size: Buffer.byteLength(content, 'utf8') };
  });
}

describe('scanWorkspaceContextFiles', () => {
  it("reports 'none' for a root with no instructions file", async () => {
    const reader = makeReader({ '/abs/repo-a': { 'README.md': 'x' } });
    const [status] = await scanWorkspaceContextFiles([ROOT_A], reader);
    expect(status?.status).toBe('none');
    expect(status?.fileName).toBeNull();
    expect(status?.sizeBytes).toBeNull();
    expect(status?.approxTokens).toBeNull();
  });

  it("reports 'fits' with size + token estimate for a small file", async () => {
    const reader = makeReader({ '/abs/repo-a': { 'AGENTS.md': 'abcd'.repeat(10) } }); // 40 chars
    const [status] = await scanWorkspaceContextFiles([ROOT_A], reader);
    expect(status?.status).toBe('fits');
    expect(status?.oversized).toBe(false);
    expect(status?.fileName).toBe('AGENTS.md');
    expect(status?.sizeBytes).toBe(40);
    expect(status?.approxTokens).toBe(10);
  });

  it("reports 'oversized' for a file over the per-file budget", async () => {
    const reader = makeReader({
      '/abs/repo-a': { 'AGENTS.md': 'x'.repeat(MAX_CONTEXT_FILE_CHARS + 1) },
    });
    const [status] = await scanWorkspaceContextFiles([ROOT_A], reader);
    expect(status?.status).toBe('oversized');
    expect(status?.oversized).toBe(true);
  });

  it('follows first-match-wins priority (AGENTS.md over CLAUDE.md)', async () => {
    const reader = makeReader({
      '/abs/repo-a': { 'AGENTS.md': 'plural', 'CLAUDE.md': 'claude' },
    });
    const [status] = await scanWorkspaceContextFiles([ROOT_A], reader);
    expect(status?.fileName).toBe('AGENTS.md');
  });

  it.each([
    ['binary', new Error('Path "AGENTS.md" is a binary file and cannot be read as text.')],
    ['oversized', new Error('Path "AGENTS.md" exceeds 2000000 bytes and cannot be read in full.')],
    [
      'permission (EACCES)',
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    ],
  ])("reports 'error' for a present-but-unreadable file (%s)", async (_label, thrown) => {
    // A non-ENOENT reader throw means the file EXISTS but cannot be read; it must
    // surface as `status:'error'`, never be fabricated into 'none'.
    const reader: WorkspaceFileReader = vi.fn(async ({ requestedPath }) => {
      if (requestedPath === 'AGENTS.md') {
        throw thrown;
      }
      throw Object.assign(new Error(`ENOENT: no such file, open '${requestedPath}'`), {
        code: 'ENOENT',
      });
    });
    const [status] = await scanWorkspaceContextFiles([ROOT_A], reader);
    expect(status?.status).toBe('error');
    expect(status?.error).toBe((thrown as Error).message);
    expect(status?.fileName).toBeNull();
    expect(status?.sizeBytes).toBeNull();
  });

  it('scans every mounted root', async () => {
    const reader = makeReader({
      '/abs/repo-a': { 'AGENTS.md': 'a' },
      '/abs/repo-b': { 'CLAUDE.md': 'b' },
    });
    const statuses = await scanWorkspaceContextFiles([ROOT_A, ROOT_B], reader);
    expect(statuses.map((s) => s.rootId)).toEqual(['root-a', 'root-b']);
    expect(statuses[0]?.fileName).toBe('AGENTS.md');
    expect(statuses[1]?.fileName).toBe('CLAUDE.md');
  });
});
