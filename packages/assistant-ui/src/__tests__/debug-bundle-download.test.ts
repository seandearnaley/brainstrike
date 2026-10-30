import { describe, expect, it } from 'vitest';
import { formatDebugBundleFilename } from '../debug-bundle-download';

const AT = new Date('2026-07-27T14:32:05.123Z');

describe('formatDebugBundleFilename', () => {
  it('stamps a filesystem-safe UTC timestamp (no colons, no millis)', () => {
    expect(formatDebugBundleFilename({ generatedAt: AT, runId: null })).toBe(
      'brainstrike-debug-bundle-2026-07-27T14-32-05Z.md'
    );
  });

  it('carries a short run id when the message has one', () => {
    expect(
      formatDebugBundleFilename({ generatedAt: AT, runId: '1a2b3c4d-5e6f-7890-abcd-ef0123456789' })
    ).toBe('brainstrike-debug-bundle-2026-07-27T14-32-05Z-run-1a2b3c4d.md');
  });

  it('omits the run segment entirely when sanitizing leaves nothing (no dangling "-run-")', () => {
    expect(formatDebugBundleFilename({ generatedAt: AT, runId: '::::' })).toBe(
      'brainstrike-debug-bundle-2026-07-27T14-32-05Z.md'
    );
  });

  it('never emits path separators or characters Windows rejects', () => {
    const filename = formatDebugBundleFilename({
      generatedAt: AT,
      runId: 'weird/run:id\\with*chars',
    });
    expect(filename).not.toMatch(/[<>:"/\\|?*]/u);
    expect(filename.endsWith('.md')).toBe(true);
  });
});
