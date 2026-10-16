import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** The module as a browser loads it: no Node builtins to reach. */
async function withoutNodeBuiltins(): Promise<typeof import('../host-path.js')> {
  vi.resetModules();
  const original = process.getBuiltinModule;
  Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: undefined });
  try {
    return await import('../host-path.js');
  } finally {
    Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: original });
  }
}

const JOINS: readonly (readonly string[])[] = [
  ['fsa:00000000-0000-4000-8000-000000000001', 'src'],
  ['fsa:00000000-0000-4000-8000-000000000001/src', 'one.ts'],
  ['/home/user/project', 'src', 'one.ts'],
  ['/home/user/project/', 'src'],
  ['a//b', './c', '../d'],
  ['/', '..', 'x'],
  ['', 'x'],
  ['', ''],
  ['dir/', ''],
  ['café 🧠', 'notes.md'],
];
const BASENAMES = [
  'fsa:00000000-0000-4000-8000-000000000001',
  '/home/user/project/',
  'a/b/c.ts',
  'x',
  '',
];

describe('host paths', () => {
  it("are Node's own where the runtime has Node", async () => {
    const { hostBasename, hostJoin } = await import('../host-path.js');
    for (const parts of JOINS) {
      expect(hostJoin(...parts)).toBe(path.join(...parts));
    }
    for (const name of BASENAMES) {
      expect(hostBasename(name)).toBe(path.basename(name));
    }
  });

  it("are POSIX's in a browser, as path.posix computes them", async () => {
    const { hostBasename, hostJoin } = await withoutNodeBuiltins();
    for (const parts of JOINS) {
      expect(hostJoin(...parts)).toBe(path.posix.join(...parts));
    }
    for (const name of BASENAMES) {
      expect(hostBasename(name)).toBe(path.posix.basename(name));
    }
  });
});
