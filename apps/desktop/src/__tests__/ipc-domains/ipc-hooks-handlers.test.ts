import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getProjectHooksForReview } from '../../ipc-hooks-handlers';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('getProjectHooksForReview', () => {
  it('rejects a non-absolute root path', () => {
    const result = getProjectHooksForReview('r1', 'relative/path', { readFile: () => '' });
    expect(result.error).toMatch(/absolute/);
    expect(result.exists).toBe(false);
  });

  it('rejects an empty rootId', () => {
    const result = getProjectHooksForReview('', '/abs', { readFile: () => '' });
    expect(result.error).toMatch(/rootId/);
  });

  it('reports exists:false when the file is missing', () => {
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.exists).toBe(false);
    expect(result.path).toBe('/abs/root/.brainstrike/hooks.json');
    expect(result.content).toBeUndefined();
  });

  it('returns content + sha256 for a valid file', () => {
    const content = '{"PreToolUse":[]}';
    const result = getProjectHooksForReview('r1', '/abs/root', { readFile: () => content });
    expect(result.exists).toBe(true);
    expect(result.content).toBe(content);
    expect(result.sha256).toBe(sha256(content));
    expect(result.parseError).toBeUndefined();
  });

  it('surfaces a parseError for malformed JSON but still returns content + hash', () => {
    const content = '{ not json';
    const result = getProjectHooksForReview('r1', '/abs/root', { readFile: () => content });
    expect(result.exists).toBe(true);
    expect(result.content).toBe(content);
    expect(result.sha256).toBe(sha256(content));
    expect(result.parseError).toBeDefined();
  });
});
