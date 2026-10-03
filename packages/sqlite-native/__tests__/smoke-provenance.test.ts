import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface TreeFacts {
  gypOutput: string[];
  natives: string[];
  unpacked: string;
}

interface SmokeLib {
  isGypOutput: (relativePath: string) => boolean;
  packagedTreeFacts: (
    resources: string,
    requireFrom: { resolve: (id: string) => string }
  ) => TreeFacts;
  provenanceFailures: (facts: unknown, options: { packaged: boolean }) => string[];
}

// The smokes are CommonJS scripts run by Electron; their judging logic is
// exercised here against fixture trees so it cannot rot unseen.
const { isGypOutput, packagedTreeFacts, provenanceFailures } = createRequire(import.meta.url)(
  '../test/smoke-lib.cjs'
) as SmokeLib;

let resources: string;

beforeEach(() => {
  resources = mkdtempSync(join(tmpdir(), 'sqlite-native-tree-'));
});

afterEach(() => {
  rmSync(resources, { force: true, recursive: true });
});

function touch(...segments: string[]): string {
  const file = join(resources, ...segments);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x');
  return file;
}

/** A `require` whose better-sqlite3 resolves inside the fixture asar view. */
function requireFromFixtureAsar(): { resolve: (id: string) => string } {
  const manifest = touch('app.asar', 'node_modules', 'better-sqlite3', 'package.json');
  return { resolve: () => manifest };
}

describe('isGypOutput', () => {
  it('matches a top-level build directory, the layout node-gyp writes', () => {
    expect(isGypOutput(join('build', 'Release', 'better_sqlite3.node'))).toBe(true);
  });

  it('matches a nested build directory', () => {
    expect(isGypOutput(join('x', 'build', 'y'))).toBe(true);
  });

  it('matches config.gypi anywhere', () => {
    expect(isGypOutput('config.gypi')).toBe(true);
    expect(isGypOutput(join('deps', 'config.gypi'))).toBe(true);
  });

  it('does not match shipped files or look-alike names', () => {
    expect(isGypOutput(join('prebuilds', 'linux-x64.node'))).toBe(false);
    expect(isGypOutput(join('lib', 'rebuild', 'index.js'))).toBe(false);
    expect(isGypOutput(join('src', 'builder.cpp'))).toBe(false);
  });
});

describe('packagedTreeFacts', () => {
  it('reports node-gyp output at the top of the unpacked package', () => {
    const compiled = touch(
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    );

    const tree = packagedTreeFacts(resources, requireFromFixtureAsar());

    expect(tree.gypOutput).toEqual([compiled]);
  });

  it('reports node-gyp output in the asar view of the package', () => {
    const config = touch('app.asar', 'node_modules', 'better-sqlite3', 'build', 'config.gypi');

    const tree = packagedTreeFacts(resources, requireFromFixtureAsar());

    expect(tree.gypOutput).toEqual([config]);
  });

  it('reports a missing unpacked package as a failure, not a crash', () => {
    mkdirSync(join(resources, 'app.asar.unpacked'), { recursive: true });

    const tree = packagedTreeFacts(resources, requireFromFixtureAsar());

    expect(tree.natives).toEqual([]);
    expect(provenanceFailures({ ...baseFacts(), tree }, { packaged: true })).toContainEqual(
      expect.stringContaining('app.asar.unpacked lacks the host better-sqlite3 prebuild')
    );
  });

  it('reports a missing app.asar.unpacked directory as a failure, not a crash', () => {
    const tree = packagedTreeFacts(resources, requireFromFixtureAsar());

    expect(tree.natives).toEqual([]);
    expect(provenanceFailures({ ...baseFacts(), tree }, { packaged: true })).toContainEqual(
      expect.stringContaining('app.asar.unpacked lacks vec0')
    );
  });
});

function baseFacts() {
  return {
    extensionPath: '',
    mappedNativeFiles: [],
    nearestId: 1,
    platform: `${process.platform}-${process.arch}`,
    requireCacheNodes: [],
    vecVersion: 'v0.1.9',
  };
}
