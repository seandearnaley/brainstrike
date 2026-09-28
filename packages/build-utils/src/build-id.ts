import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';

/** The global each renderer entry reads; its `.d.ts` lives beside the entry. */
export const BUILD_ID_DEFINE_NAME = '__BRAINSTRIKE_BUILD_ID__';

/** What the dev server (and Vitest) get. A production build never falls back to it. */
export const DEV_BUILD_ID = 'dev';

export interface BuildIdSource {
  /** Shown in the failure message when nothing resolves. */
  readonly name: string;
  /** `undefined` or blank means "not set". A throw means "could not be read". */
  readonly read: () => string | undefined;
}

export function envBuildIdSource(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): BuildIdSource {
  return { name, read: () => env[name] };
}

export function gitHeadBuildIdSource(cwd: string): BuildIdSource {
  return {
    name: 'git rev-parse HEAD',
    read: () =>
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
  };
}

/**
 * Identifies the build a renderer bundle came from, so a reload that lands on
 * the SAME id can be told apart from one that picked up a new deployment.
 *
 * Only `vite serve` (which includes Vitest) gets the `dev` literal. A
 * production build with no resolvable id throws: a silent default would make
 * every build look identical and turn the reload guard into a permanent
 * "reloading didn't fix this".
 */
export function resolveBuildId({
  command,
  sources,
}: {
  readonly command: 'build' | 'serve';
  readonly sources: readonly BuildIdSource[];
}): string {
  if (command === 'serve') {
    return DEV_BUILD_ID;
  }
  const misses: string[] = [];
  for (const { name, read } of sources) {
    try {
      const value = read()?.trim();
      if (value) {
        return value;
      }
      misses.push(`${name}: not set`);
    } catch (error) {
      misses.push(`${name}: ${error instanceof Error ? error.message.trim() : String(error)}`);
    }
  }
  throw new Error(
    `No build id could be resolved for ${BUILD_ID_DEFINE_NAME}. Tried:\n  ${misses.join('\n  ')}`
  );
}

/** Defines `__BRAINSTRIKE_BUILD_ID__` for the app it is installed in. */
export function buildIdPlugin(sources: readonly BuildIdSource[]): Plugin {
  return {
    config(_config, { command }) {
      return {
        define: {
          [BUILD_ID_DEFINE_NAME]: JSON.stringify(resolveBuildId({ command, sources })),
        },
      };
    },
    name: 'brainstrike-build-id',
  };
}
