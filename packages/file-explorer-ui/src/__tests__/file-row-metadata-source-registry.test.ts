// @vitest-environment node
/**
 * Per-root source dispatch for the metadata seam (BST-1208).
 *
 * The CARRIED contract from the BST-1207 review lives here: a directory the
 * registry cannot enumerate must read as an explicit incomplete subtree. The
 * type is non-nullable, so a lazily expanded row renders an honest partial
 * marker instead of forcing every caller to handle a `null`.
 *
 * The visible-file key merge (whole-branch review F2) is pinned here too: it is
 * the same per-root shape, and its CONTENT stability is what keeps an unchanged
 * republication from re-arming the indexer's visible-file debounce.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { createLogger } from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetMalformedKeyReportingForTests,
  createFileRowMetadataSourceRegistry,
  type FileRowMetadataSource,
} from '../indexing/file-row-metadata-source-registry';

const registryLogger = createLogger('FileRowMetadataSourceRegistry');
let errorSpy: ReturnType<typeof vi.spyOn>;

const ROOT_A = 'root-a';
const ROOT_B = 'root-b';

function stubSource(overrides: Partial<FileRowMetadataSource> = {}): FileRowMetadataSource {
  return {
    getDirectorySubtree: () => ({ fileKeys: [], isComplete: true }),
    getNodeSize: () => undefined,
    ...overrides,
  };
}

describe('file row metadata source registry', () => {
  beforeEach(() => {
    __resetMalformedKeyReportingForTests();
    errorSpy = vi.spyOn(registryLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('dispatches to the source that owns the key’s root', () => {
    const registry = createFileRowMetadataSourceRegistry();
    registry.register(ROOT_A, stubSource({ getNodeSize: () => 10 }));
    registry.register(ROOT_B, stubSource({ getNodeSize: () => 20 }));

    expect(registry.getNodeSize(encodeFileSelection(ROOT_A, 'src/a.ts'))).toBe(10);
    expect(registry.getNodeSize(encodeFileSelection(ROOT_B, 'src/a.ts'))).toBe(20);
  });

  it('passes the PATH half of the key to the source', () => {
    const registry = createFileRowMetadataSourceRegistry();
    const seen: string[] = [];
    registry.register(
      ROOT_A,
      stubSource({
        getNodeSize: (path) => {
          seen.push(path);
          return;
        },
      })
    );

    registry.getNodeSize(encodeFileSelection(ROOT_A, 'src/nested/a.ts'));
    expect(seen).toEqual(['src/nested/a.ts']);
  });

  /**
   * The two failure modes are NOT the same and must not be conflated: an
   * unregistered root is legitimate and transient (a section unmounting while a
   * cell is still subscribed), so it stays quiet; a malformed key is an
   * invariant violation that nothing will ever resolve, so it must surface.
   */
  it('reports an INCOMPLETE subtree — never null — for an unregistered root, and stays QUIET', () => {
    const registry = createFileRowMetadataSourceRegistry();
    expect(registry.getDirectorySubtree(encodeFileSelection(ROOT_A, 'src'))).toEqual({
      fileKeys: [],
      incompleteReason: 'not-enumerated',
      isComplete: false,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('LOGS a malformed key at error level instead of masking it as unfinished work', () => {
    const registry = createFileRowMetadataSourceRegistry();
    expect(registry.getDirectorySubtree('not-a-composite-key')).toEqual({
      fileKeys: [],
      incompleteReason: 'not-enumerated',
      isComplete: false,
    });
    expect(registry.getNodeSize('not-a-composite-key')).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('logs each malformed key ONCE so a render loop cannot flood the log', () => {
    const registry = createFileRowMetadataSourceRegistry();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      registry.getNodeSize('still-not-a-composite-key');
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * The dedupe cap must EVICT, not stop admitting. A cap that refuses new
   * entries once full turns every key past it into a per-call error log — the
   * exact flood the cap exists to prevent, and the worst case is a virtualized
   * tree remounting these reads constantly.
   */
  it('keeps logging once-per-key after the dedupe cap fills', () => {
    const registry = createFileRowMetadataSourceRegistry();
    // Overflow the cap comfortably.
    for (let index = 0; index < 150; index += 1) {
      registry.getNodeSize(`malformed-${index}`);
    }
    expect(errorSpy).toHaveBeenCalledTimes(150);

    errorSpy.mockClear();
    // The most recent keys are still remembered, so repeating them stays quiet.
    for (let index = 100; index < 150; index += 1) {
      registry.getNodeSize(`malformed-${index}`);
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  describe('visible file keys', () => {
    it('merges every root, so a forest indexes more than the focused section', () => {
      const registry = createFileRowMetadataSourceRegistry();
      registry.setVisibleFileKeys(ROOT_A, new Set(['a|@|/a/one.ts']));
      registry.setVisibleFileKeys(ROOT_B, new Set(['b|@|/b/two.ts']));

      expect([...registry.getVisibleFileKeys()].sort()).toEqual(['a|@|/a/one.ts', 'b|@|/b/two.ts']);
    });

    it('keeps the snapshot identity when a republication changes nothing', () => {
      const registry = createFileRowMetadataSourceRegistry();
      registry.setVisibleFileKeys(ROOT_A, new Set(['a|@|/a/one.ts']));
      const first = registry.getVisibleFileKeys();
      const listener = vi.fn();
      registry.subscribeVisibleFileKeys(listener);

      // A fresh Set with identical membership — exactly what a tree commit that
      // changed nothing visible produces.
      registry.setVisibleFileKeys(ROOT_A, new Set(['a|@|/a/one.ts']));

      expect(registry.getVisibleFileKeys()).toBe(first);
      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies and re-snapshots when membership actually moves', () => {
      const registry = createFileRowMetadataSourceRegistry();
      registry.setVisibleFileKeys(ROOT_A, new Set(['a|@|/a/one.ts']));
      const first = registry.getVisibleFileKeys();
      const listener = vi.fn();
      registry.subscribeVisibleFileKeys(listener);

      registry.setVisibleFileKeys(ROOT_A, new Set(['a|@|/a/one.ts', 'a|@|/a/two.ts']));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(registry.getVisibleFileKeys()).not.toBe(first);
      expect(registry.getVisibleFileKeys().size).toBe(2);
    });

    it('withdraws a root’s keys when its section unmounts', () => {
      const registry = createFileRowMetadataSourceRegistry();
      registry.setVisibleFileKeys(ROOT_A, new Set(['a|@|/a/one.ts']));
      registry.setVisibleFileKeys(ROOT_B, new Set(['b|@|/b/two.ts']));

      registry.setVisibleFileKeys(ROOT_B, new Set());

      expect([...registry.getVisibleFileKeys()]).toEqual(['a|@|/a/one.ts']);
    });

    it('answers a shared empty snapshot before any root publishes', () => {
      const first = createFileRowMetadataSourceRegistry();
      const second = createFileRowMetadataSourceRegistry();

      expect(first.getVisibleFileKeys().size).toBe(0);
      expect(first.getVisibleFileKeys()).toBe(second.getVisibleFileKeys());
    });
  });

  it('unregisters only its own source, so a remount-before-cleanup keeps the root sourced', () => {
    const registry = createFileRowMetadataSourceRegistry();
    const first = stubSource({ getNodeSize: () => 1 });
    const second = stubSource({ getNodeSize: () => 2 });
    const unregisterFirst = registry.register(ROOT_A, first);
    registry.register(ROOT_A, second);

    unregisterFirst();

    expect(registry.getNodeSize(encodeFileSelection(ROOT_A, 'a.ts'))).toBe(2);
  });
});
