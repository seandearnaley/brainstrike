/**
 * Real-subprocess coverage for the post-edit LSP diagnostics manager (report
 * R2 Phase A). Spawns the BUNDLED typescript-language-server (a Node child
 * process in desktop main) against real temp files — mirrors the
 * execute-command integration tests, whose heart is the "no orphaned process"
 * proof. No child_process mocking: the wire protocol is only meaningful end to
 * end.
 *
 * Contract asserted here:
 *  - a TS file carrying a type error surfaces a bounded diagnostic,
 *  - a clean TS file reports available:true with no diagnostics,
 *  - an unsupported language is silently omitted (available:false, no note
 *    spam on every markdown/json edit),
 *  - the pool reuses one server per root (no re-spawn per edit),
 *  - disposeLspServers() actually kills the spawned process (no orphan),
 *  - a missing/unresolvable server degrades to an honest note, never a throw.
 */
import { spawnSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

import {
  __getPooledPidsForTest,
  countPooledLspServers,
  disposeLspServers,
  evictLspServersForRoot,
  getEditDiagnostics,
} from '../../assistant-server/lsp-diagnostics';

async function makeRoot(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-lsp-'));
  await fsPromises.writeFile(path.join(root, 'package.json'), '{"name":"lsp-fixture"}', 'utf8');
  return fsPromises.realpath(root);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('lsp-diagnostics manager (real typescript-language-server subprocess)', () => {
  afterEach(async () => {
    await disposeLspServers();
  });

  it('surfaces a bounded diagnostic for a TS file with a type error', async () => {
    const root = await makeRoot();
    try {
      const content = 'const x: number = "not a number";\n';
      await fsPromises.writeFile(path.join(root, 'bad.ts'), content, 'utf8');

      const result = await getEditDiagnostics({
        absolutePath: path.join(root, 'bad.ts'),
        content,
        rootId: 'root-1',
        rootPath: root,
      });

      expect(result.available).toBe(true);
      expect(result.language).toBe('typescript');
      expect(result.diagnostics?.length ?? 0).toBeGreaterThan(0);
      const first = result.diagnostics?.[0];
      expect(first?.severity).toBe('error');
      expect(first?.message).toMatch(/not assignable/i);
      // 1-based line for the model (LSP is 0-based on the wire).
      expect(first?.line).toBe(1);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('reports available:true with no diagnostics for a clean TS file', async () => {
    const root = await makeRoot();
    try {
      const content = 'export const add = (a: number, b: number): number => a + b;\n';
      await fsPromises.writeFile(path.join(root, 'ok.ts'), content, 'utf8');

      const result = await getEditDiagnostics({
        absolutePath: path.join(root, 'ok.ts'),
        content,
        rootId: 'root-1',
        rootPath: root,
      });

      expect(result.available).toBe(true);
      expect(result.diagnostics ?? []).toEqual([]);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('omits diagnostics for an unsupported language (no note spam)', async () => {
    const root = await makeRoot();
    try {
      const content = '# Heading\n';
      await fsPromises.writeFile(path.join(root, 'readme.md'), content, 'utf8');

      const result = await getEditDiagnostics({
        absolutePath: path.join(root, 'readme.md'),
        content,
        rootId: 'root-1',
        rootPath: root,
      });

      expect(result.available).toBe(false);
      expect(result.reason).toBe('unsupported-language');
      // Nothing was spawned for an unsupported language.
      expect(countPooledLspServers()).toBe(0);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('reuses one pooled server per root across edits (no re-spawn)', async () => {
    const root = await makeRoot();
    try {
      await fsPromises.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
      await fsPromises.writeFile(path.join(root, 'b.ts'), 'export const b = 2;\n', 'utf8');

      await getEditDiagnostics({
        absolutePath: path.join(root, 'a.ts'),
        content: 'export const a = 1;\n',
        rootId: 'root-1',
        rootPath: root,
      });
      const pidsAfterFirst = __getPooledPidsForTest();
      expect(pidsAfterFirst).toHaveLength(1);

      await getEditDiagnostics({
        absolutePath: path.join(root, 'b.ts'),
        content: 'export const b = 2;\n',
        rootId: 'root-1',
        rootPath: root,
      });
      const pidsAfterSecond = __getPooledPidsForTest();
      expect(pidsAfterSecond).toEqual(pidsAfterFirst);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('disposeLspServers kills the spawned process (no orphan)', async () => {
    const root = await makeRoot();
    try {
      await fsPromises.writeFile(path.join(root, 'c.ts'), 'export const c = 3;\n', 'utf8');
      await getEditDiagnostics({
        absolutePath: path.join(root, 'c.ts'),
        content: 'export const c = 3;\n',
        rootId: 'root-1',
        rootPath: root,
      });
      const [pid] = __getPooledPidsForTest();
      expect(pid).toBeGreaterThan(0);
      expect(isProcessAlive(pid)).toBe(true);

      const disposed = await disposeLspServers();
      expect(disposed).toBeGreaterThanOrEqual(1);
      expect(countPooledLspServers()).toBe(0);
      // Give the OS a beat to reap.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('evictLspServersForRoot disposes only that root and leaves others', async () => {
    const rootA = await makeRoot();
    const rootB = await makeRoot();
    try {
      await fsPromises.writeFile(path.join(rootA, 'a.ts'), 'export const a = 1;\n', 'utf8');
      await fsPromises.writeFile(path.join(rootB, 'b.ts'), 'export const b = 2;\n', 'utf8');
      await getEditDiagnostics({
        absolutePath: path.join(rootA, 'a.ts'),
        content: 'export const a = 1;\n',
        rootId: 'root-a',
        rootPath: rootA,
      });
      await getEditDiagnostics({
        absolutePath: path.join(rootB, 'b.ts'),
        content: 'export const b = 2;\n',
        rootId: 'root-b',
        rootPath: rootB,
      });
      expect(countPooledLspServers()).toBe(2);

      await evictLspServersForRoot('root-a');
      expect(countPooledLspServers()).toBe(1);
    } finally {
      await fsPromises.rm(rootA, { force: true, recursive: true });
      await fsPromises.rm(rootB, { force: true, recursive: true });
    }
  }, 30_000);

  it('degrades to an honest note (never throws) when the server binary cannot resolve', async () => {
    const root = await makeRoot();
    try {
      await fsPromises.writeFile(path.join(root, 'd.ts'), 'export const d = 4;\n', 'utf8');
      const result = await getEditDiagnostics({
        absolutePath: path.join(root, 'd.ts'),
        content: 'export const d = 4;\n',
        // Inject a resolver that reports the server as unavailable.
        resolveServerForTest: () => null,
        rootId: 'root-1',
        rootPath: root,
      });
      expect(result.available).toBe(false);
      expect(result.reason).toBe('server-unavailable');
      expect(result.message).toMatch(/language server/i);
      expect(countPooledLspServers()).toBe(0);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('has the bundled typescript-language-server resolvable (bundle invariant)', () => {
    // Guards the "bundle the TS server" decision: a resolution failure here
    // means the dependency was dropped and diagnostics would silently degrade.
    const check = spawnSync(
      process.execPath,
      [
        '-e',
        "require.resolve('typescript-language-server/lib/cli.mjs'); require.resolve('typescript/package.json')",
      ],
      { cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8' }
    );
    expect(check.status).toBe(0);
  });
});
