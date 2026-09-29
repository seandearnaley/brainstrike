import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILD_ID_DEFINE_NAME,
  type BuildIdSource,
  buildIdPlugin,
  DEV_BUILD_ID,
  envBuildIdSource,
  gitHeadBuildIdSource,
  resolveBuildId,
} from '../build-id.js';

const source = (name: string, read: () => string | undefined): BuildIdSource => ({ name, read });

describe('resolveBuildId', () => {
  it('returns the dev literal in serve mode without reading any source', () => {
    const read = vi.fn(() => 'abc');

    expect(resolveBuildId({ command: 'serve', sources: [source('A', read)] })).toBe(DEV_BUILD_ID);
    expect(read).not.toHaveBeenCalled();
  });

  it('returns the first source that resolves and reads no later one', () => {
    const later = vi.fn(() => 'later');

    const id = resolveBuildId({
      command: 'build',
      sources: [source('A', () => undefined), source('B', () => 'from-b'), source('C', later)],
    });

    expect(id).toBe('from-b');
    expect(later).not.toHaveBeenCalled();
  });

  it('treats blank values as unset and trims the winner', () => {
    const id = resolveBuildId({
      command: 'build',
      sources: [source('A', () => '   '), source('B', () => ''), source('C', () => ' sha-1 \n')],
    });

    expect(id).toBe('sha-1');
  });

  it('throws in a production build when nothing resolves, naming every source and why', () => {
    expect(() =>
      resolveBuildId({
        command: 'build',
        sources: [
          source('VERCEL_DEPLOYMENT_ID', () => undefined),
          source('git HEAD', () => {
            throw new Error('not a git repository');
          }),
        ],
      })
    ).toThrow(
      /No build id could be resolved[\s\S]*VERCEL_DEPLOYMENT_ID: not set[\s\S]*git HEAD: not a git repository/
    );
  });

  it('still tries later sources after an earlier one throws', () => {
    const id = resolveBuildId({
      command: 'build',
      sources: [
        source('A', () => {
          throw new Error('boom');
        }),
        source('B', () => 'fallback-free'),
      ],
    });

    expect(id).toBe('fallback-free');
  });

  it('never returns the dev literal for a build with no sources', () => {
    expect(() => resolveBuildId({ command: 'build', sources: [] })).toThrow(
      /No build id could be resolved/
    );
  });
});

describe('envBuildIdSource', () => {
  it('reads the named variable from the given environment', () => {
    expect(envBuildIdSource('GITHUB_SHA', { GITHUB_SHA: 'deadbeef' }).read()).toBe('deadbeef');
    expect(envBuildIdSource('GITHUB_SHA', {}).read()).toBeUndefined();
  });

  it('is named after the variable', () => {
    expect(envBuildIdSource('VERCEL_DEPLOYMENT_ID', {}).name).toBe('VERCEL_DEPLOYMENT_ID');
  });
});

describe('gitHeadBuildIdSource', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

  it('reads HEAD of the repository at cwd', () => {
    expect(gitHeadBuildIdSource(repoRoot).read()).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('throws, rather than returning nothing, outside a repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-build-id-'));
    try {
      expect(() => gitHeadBuildIdSource(dir).read()).toThrow(/git rev-parse HEAD/u);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe('buildIdPlugin', () => {
  function runConfigHook(plugin: Plugin, command: 'build' | 'serve') {
    const hook = plugin.config;
    if (typeof hook !== 'function') {
      throw new Error('buildIdPlugin must define a plain config hook');
    }
    return hook.call({} as ThisParameterType<typeof hook>, {}, { command, mode: 'production' });
  }

  it('defines the build id constant as a JSON string literal', () => {
    const plugin = buildIdPlugin([source('A', () => 'abc-123')]);

    expect(runConfigHook(plugin, 'build')).toEqual({
      define: { [BUILD_ID_DEFINE_NAME]: '"abc-123"' },
    });
  });

  it('defines the dev literal for the dev server', () => {
    const plugin = buildIdPlugin([source('A', () => undefined)]);

    expect(runConfigHook(plugin, 'serve')).toEqual({
      define: { [BUILD_ID_DEFINE_NAME]: `"${DEV_BUILD_ID}"` },
    });
  });

  it('fails the production build when nothing resolves', () => {
    const plugin = buildIdPlugin([source('A', () => undefined)]);

    expect(() => runConfigHook(plugin, 'build')).toThrow(/No build id could be resolved/);
  });
});
