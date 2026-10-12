import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { type Manifest, StateStore, sha256Hex } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

function bundleFixture(unsafePath?: string): {
  bundle: string;
  target: string;
  victim: string;
  manifest: Manifest;
} {
  const sourceParent = freshDir('bundle-path-source');
  const targetParent = freshDir('bundle-path-target');
  const bundle = join(sourceParent, 'bundle');
  const target = join(targetParent, 'root');
  const victim = join(targetParent, 'escape.txt');
  mkdirSync(bundle);
  writeFileSync(victim, 'owned sibling bytes');
  const files = [
    { content: Buffer.from('retained snapshot bytes'), path: 'state.db' },
    { content: Buffer.from('retained blob bytes'), path: 'blobs/content-addressed' },
    ...(unsafePath === undefined
      ? []
      : [{ content: Buffer.from('outside bundle bytes'), path: unsafePath }]),
  ];
  for (const [index, file] of files.entries()) {
    // Only the reproduced traversal accesses a sibling, owned by this fixture.
    if (index >= 2 && file.path !== '../escape.txt') {
      continue;
    }
    const path = join(bundle, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  const manifest: Manifest = {
    files: files.map((file) => ({
      bytes: file.content.length,
      path: file.path,
      sha256: sha256Hex(file.content),
    })),
    format: 1,
    sourceHost: 'test-host',
    threads: [],
  };
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
  return { bundle, manifest, target, victim };
}

test.each([
  '../escape.txt',
  'nested/../../escape.txt',
  '/absolute/escape.txt',
  '..\\escape.txt',
  'nested\\..\\escape.txt',
  'C:\\escape.txt',
  'C:escape.txt',
  '//server/share/escape.txt',
  './state.db',
  'nested/../state.db',
  'nested//escape.txt',
  '',
  'nul\0escape.txt',
])('rejects unsafe manifest path %s before writing any bundle file', (unsafePath) => {
  const fixture = bundleFixture(unsafePath);
  expect(() => StateStore.importBundle(fixture.bundle, fixture.target)).toThrow(TypeError);
  expect(existsSync(fixture.target)).toBe(false);
  expect(readFileSync(fixture.victim, 'utf8')).toBe('owned sibling bytes');
});

test('preserves a valid checksummed nested bundle and its lock files', () => {
  const fixture = bundleFixture();
  mkdirSync(join(fixture.bundle, 'lock'));
  writeFileSync(join(fixture.bundle, 'lock', 'g000000000001'), 'original lock bytes');
  expect(StateStore.importBundle(fixture.bundle, fixture.target)).toEqual(fixture.manifest);
  for (const file of fixture.manifest.files) {
    expect(readFileSync(join(fixture.target, file.path))).toEqual(
      readFileSync(join(fixture.bundle, file.path))
    );
  }
  expect(readFileSync(join(fixture.target, 'lock', 'g000000000001'), 'utf8')).toBe(
    'original lock bytes'
  );
  expect(readFileSync(fixture.victim, 'utf8')).toBe('owned sibling bytes');
});

test.skipIf(process.platform === 'win32').each(['file', 'directory', 'lock', 'manifest'] as const)(
  'rejects a source %s symlink outside the bundle before copying',
  (kind) => {
    const fixture = bundleFixture();
    const outside = freshDir('bundle-outside');
    if (kind === 'file') {
      const source = join(fixture.bundle, 'blobs/content-addressed');
      const external = join(outside, 'content-addressed');
      writeFileSync(external, readFileSync(source));
      rmSync(source);
      symlinkSync(external, source);
    } else if (kind === 'directory') {
      const source = join(fixture.bundle, 'blobs');
      writeFileSync(
        join(outside, 'content-addressed'),
        readFileSync(join(source, 'content-addressed'))
      );
      rmSync(source, { recursive: true });
      symlinkSync(outside, source);
    } else if (kind === 'lock') {
      writeFileSync(join(outside, 'g000000000001'), 'outside lock bytes');
      symlinkSync(outside, join(fixture.bundle, 'lock'));
    } else {
      const source = join(fixture.bundle, 'manifest.json');
      const external = join(outside, 'manifest.json');
      writeFileSync(external, readFileSync(source));
      rmSync(source);
      symlinkSync(external, source);
    }
    expect(() => StateStore.importBundle(fixture.bundle, fixture.target)).toThrow(TypeError);
    expect(existsSync(fixture.target)).toBe(false);
    expect(readFileSync(fixture.victim, 'utf8')).toBe('owned sibling bytes');
  }
);

test.skipIf(process.platform === 'win32')(
  'preserves a source symlink whose resolved bytes remain inside the bundle',
  () => {
    const fixture = bundleFixture();
    const source = join(fixture.bundle, 'blobs/content-addressed');
    const contained = join(fixture.bundle, 'retained-blob');
    writeFileSync(contained, readFileSync(source));
    rmSync(source);
    symlinkSync(contained, source);
    StateStore.importBundle(fixture.bundle, fixture.target);
    expect(readFileSync(join(fixture.target, 'blobs/content-addressed'))).toEqual(
      readFileSync(contained)
    );
  }
);

test.skipIf(process.platform === 'win32')(
  'refuses a nonempty destination containing a symlink without altering its target',
  () => {
    const fixture = bundleFixture();
    const outside = freshDir('bundle-target-outside');
    const protectedFile = join(outside, 'content-addressed');
    writeFileSync(protectedFile, 'protected outside bytes');
    mkdirSync(fixture.target);
    symlinkSync(outside, join(fixture.target, 'blobs'));
    expect(() => StateStore.importBundle(fixture.bundle, fixture.target)).toThrow();
    expect(existsSync(join(fixture.target, 'state.db'))).toBe(false);
    expect(readFileSync(protectedFile, 'utf8')).toBe('protected outside bytes');
  }
);
