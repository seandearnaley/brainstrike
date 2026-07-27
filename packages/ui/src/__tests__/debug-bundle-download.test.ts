import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadDebugBundleFile,
  formatDebugBundleFilename,
} from '../assistant-ui-panel/debug-bundle-download';

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
    expect(filename).not.toMatch(/[<>:"/\\|?*]/);
    expect(filename.endsWith('.md')).toBe(true);
  });
});

describe('downloadDebugBundleFile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes a text/markdown blob through an anchor and revokes the object URL a task later', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    downloadDebugBundleFile({ contents: '# bundle', filename: 'bundle.md' });

    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('text/markdown;charset=utf-8');
    expect(anchor.download).toBe('bundle.md');
    expect(anchor.href).toContain('blob:bundle');
    expect(click).toHaveBeenCalledTimes(1);
    // WebKit can fetch the blob a task after the click, so revoking inside
    // the same task would silently drop the file.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:bundle');
  });

  it('revokes the object URL even when the anchor click throws', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(() => {
      throw new Error('click blocked');
    });
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    expect(() => downloadDebugBundleFile({ contents: '# bundle', filename: 'bundle.md' })).toThrow(
      'click blocked'
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:bundle');
  });
});
