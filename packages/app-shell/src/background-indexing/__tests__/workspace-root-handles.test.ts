import type { DirectoryHandle } from '@brainstrike/file-system';
import { describe, expect, it } from 'vitest';
import { createMountedRootIdentityKey, getActiveRootHandles } from '../workspace-root-handles';

/**
 * Paired tests for the mounted-root helpers named in the coverage-audit
 * contract in `packages/app-shell/AGENTS.md`. Both helpers are pure, so no
 * provider is mounted here.
 */

function makeDirectoryHandle(path: string, rootId?: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.split('/').at(-1) ?? path,
    path,
    platform: 'electron',
    ...(rootId === undefined ? {} : { rootId }),
  };
}

describe('getActiveRootHandles', () => {
  it('returns the multi-root list unchanged when one is mounted', () => {
    const rootDirectoryHandles = [
      makeDirectoryHandle('/workspace/a'),
      makeDirectoryHandle('/workspace/b'),
    ];
    // Identity matters: the result feeds render-stable memo dependencies.
    expect(getActiveRootHandles({ rootDirectoryHandle: null, rootDirectoryHandles })).toBe(
      rootDirectoryHandles
    );
  });

  it('prefers the multi-root list over a legacy single handle', () => {
    const rootDirectoryHandles = [makeDirectoryHandle('/workspace/a')];
    expect(
      getActiveRootHandles({
        rootDirectoryHandle: makeDirectoryHandle('/workspace/legacy'),
        rootDirectoryHandles,
      })
    ).toBe(rootDirectoryHandles);
  });

  it('falls back to the legacy single handle when no multi-root list is mounted', () => {
    const rootDirectoryHandle = makeDirectoryHandle('/workspace/legacy');
    expect(getActiveRootHandles({ rootDirectoryHandle, rootDirectoryHandles: [] })).toEqual([
      rootDirectoryHandle,
    ]);
  });

  it('returns nothing mounted when neither shape has a root', () => {
    expect(getActiveRootHandles({ rootDirectoryHandle: null, rootDirectoryHandles: [] })).toEqual(
      []
    );
  });
});

describe('createMountedRootIdentityKey', () => {
  it('prefers the handle root id over the path map', () => {
    expect(
      createMountedRootIdentityKey(
        makeDirectoryHandle('/workspace/a', 'from-handle'),
        new Map([['/workspace/a', 'from-map']])
      )
    ).toBe(JSON.stringify(['from-handle', '/workspace/a']));
  });

  it('falls back to the path map when the handle carries no root id', () => {
    expect(
      createMountedRootIdentityKey(
        makeDirectoryHandle('/workspace/a'),
        new Map([['/workspace/a', 'from-map']])
      )
    ).toBe(JSON.stringify(['from-map', '/workspace/a']));
  });

  it('falls back to a null root id when neither source knows one', () => {
    expect(createMountedRootIdentityKey(makeDirectoryHandle('/workspace/a'), new Map())).toBe(
      JSON.stringify([null, '/workspace/a'])
    );
  });

  it('is stable across handle object identity for the same root', () => {
    const rootIdByPath = new Map<string, string>();
    expect(createMountedRootIdentityKey(makeDirectoryHandle('/a', 'root-1'), rootIdByPath)).toBe(
      createMountedRootIdentityKey(makeDirectoryHandle('/a', 'root-1'), rootIdByPath)
    );
  });

  it('separates two roots that share a path but differ by root id', () => {
    // On web, `path` is only the directory name, so two folders both named
    // "project" collide unless the durable root id participates in identity.
    const rootIdByPath = new Map<string, string>();
    expect(
      createMountedRootIdentityKey(makeDirectoryHandle('project', 'root-1'), rootIdByPath)
    ).not.toBe(
      createMountedRootIdentityKey(makeDirectoryHandle('project', 'root-2'), rootIdByPath)
    );
  });

  it('separates two roots that share a root id but differ by path', () => {
    const rootIdByPath = new Map<string, string>();
    expect(
      createMountedRootIdentityKey(makeDirectoryHandle('/a', 'root-1'), rootIdByPath)
    ).not.toBe(createMountedRootIdentityKey(makeDirectoryHandle('/b', 'root-1'), rootIdByPath));
  });
});
