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
 *  - concurrent first-touches of different files under one root spawn exactly
 *    one server (per-root creation is serialized; no orphaned child),
 *  - disposeLspServers() actually kills the spawned process (no orphan),
 *  - a missing/unresolvable server degrades to an honest note, never a throw.
 */
import { spawnSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

import {
  __getPooledLifecycleForTest,
  __getPooledPidsForTest,
  countPooledLspServers,
  disposeLspServers,
  evictLspServersForRoot,
  getEditDiagnostics,
  getLspInspection,
  resolveBundledTsserverPath,
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

  it('keeps the bundled TS6 server clean on the TS7-checked WebGPU surface', async () => {
    // BST-1011 deliberately keeps the LSP on the classic TS6 server while CI
    // type-checks with native TS7. This real-workspace control prevents the
    // device-detection WebGPU declarations from becoming LSP-only false
    // positives that the native checker cannot see.
    const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
    const absolutePath = path.join(repoRoot, 'packages/embeddings/src/device-detection.ts');
    const content = await fsPromises.readFile(absolutePath, 'utf8');

    const result = await getEditDiagnostics({
      absolutePath,
      content,
      rootId: 'brainstrike-webgpu-compat',
      rootPath: repoRoot,
    });

    expect(result.available, result.message ?? result.reason).toBe(true);
    expect(result.diagnostics ?? []).toEqual([]);
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
      const pidsAfterFirst = await __getPooledPidsForTest();
      expect(pidsAfterFirst).toHaveLength(1);

      await getEditDiagnostics({
        absolutePath: path.join(root, 'b.ts'),
        content: 'export const b = 2;\n',
        rootId: 'root-1',
        rootPath: root,
      });
      const pidsAfterSecond = await __getPooledPidsForTest();
      expect(pidsAfterSecond).toEqual(pidsAfterFirst);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('spawns exactly one server when two files under one root are first-touched concurrently', async () => {
    // The diagnose locks are per-FILE, so two concurrent first-touches of
    // DIFFERENT files under the same root race pool acquisition. A bare
    // get → create → set there would let each spawn a server child and orphan
    // one (leaked process, never disposed). acquireLspServer registers the
    // pool entry synchronously at the miss check, so exactly one child may
    // ever exist per root — asserted via pool size + pids.
    const root = await makeRoot();
    try {
      const contentA = 'export const first = 1;\n';
      const contentB = 'export const second = 2;\n';
      await fsPromises.writeFile(path.join(root, 'first.ts'), contentA, 'utf8');
      await fsPromises.writeFile(path.join(root, 'second.ts'), contentB, 'utf8');

      const [resultA, resultB] = await Promise.all([
        getEditDiagnostics({
          absolutePath: path.join(root, 'first.ts'),
          content: contentA,
          rootId: 'root-1',
          rootPath: root,
        }),
        getEditDiagnostics({
          absolutePath: path.join(root, 'second.ts'),
          content: contentB,
          rootId: 'root-1',
          rootPath: root,
        }),
      ]);

      expect(resultA.available).toBe(true);
      expect(resultB.available).toBe(true);
      expect(countPooledLspServers()).toBe(1);
      const pids = await __getPooledPidsForTest();
      expect(pids).toHaveLength(1);
      expect(isProcessAlive(pids[0] ?? -1)).toBe(true);
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
      const pid = (await __getPooledPidsForTest())[0] ?? -1;
      expect(pid).toBeGreaterThan(0);
      expect(isProcessAlive(pid)).toBe(true);

      const disposed = await disposeLspServers();
      expect(disposed).toBeGreaterThanOrEqual(1);
      expect(countPooledLspServers()).toBe(0);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('does not treat a post-spawn child error as process exit', async () => {
    const root = await makeRoot();
    try {
      const filePath = path.join(root, 'runtime-error.ts');
      const content = 'export const value = 1;\n';
      await fsPromises.writeFile(filePath, content, 'utf8');
      await getEditDiagnostics({
        absolutePath: filePath,
        content,
        rootId: 'runtime-error-root',
        rootPath: root,
      });
      const pid = (await __getPooledPidsForTest())[0] ?? -1;
      const lifecycle = await __getPooledLifecycleForTest('runtime-error-root');

      lifecycle.emitChildError(new Error('synthetic post-spawn runtime error'));
      await lifecycle.dispose();

      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('shares child settlement across re-entrant dispose callers', async () => {
    const root = await makeRoot();
    try {
      const filePath = path.join(root, 'reentrant-dispose.ts');
      const content = 'export const value = 1;\n';
      await fsPromises.writeFile(filePath, content, 'utf8');
      await getEditDiagnostics({
        absolutePath: filePath,
        content,
        rootId: 'reentrant-root',
        rootPath: root,
      });
      const lifecycle = await __getPooledLifecycleForTest('reentrant-root');

      const first = lifecycle.dispose();
      const second = lifecycle.dispose();

      expect(second).toBe(first);
      await first;
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('surfaces a failed authoritative kill after attempting global disposal', async () => {
    const root = await makeRoot();
    try {
      const filePath = path.join(root, 'kill-failure.ts');
      const content = 'export const value = 1;\n';
      await fsPromises.writeFile(filePath, content, 'utf8');
      await getEditDiagnostics({
        absolutePath: filePath,
        content,
        rootId: 'kill-failure-root',
        rootPath: root,
      });
      const lifecycle = await __getPooledLifecycleForTest('kill-failure-root');
      lifecycle.rejectNextKill();

      try {
        await expect(disposeLspServers()).rejects.toThrow(/failed to terminate LSP subprocess/i);
      } finally {
        await lifecycle.forceKill();
      }
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('serializes concurrent same-file diagnoses so results are not cross-attributed', async () => {
    // Two concurrent edits to the SAME file with different content: without
    // per-file serialization the shared per-connection diagnostics map could
    // cross-attribute one edit's result to the other. With the diagnose lock,
    // the first-submitted call fully resolves against ITS content before the
    // second runs — so the type-error content reports the error and the clean
    // content reports clean, deterministically.
    const root = await makeRoot();
    try {
      const filePath = path.join(root, 'racy.ts');
      const errorContent = 'const x: number = "bad";\n';
      const cleanContent = 'export const y: number = 1;\n';
      await fsPromises.writeFile(filePath, errorContent, 'utf8');

      const [errorResult, cleanResult] = await Promise.all([
        getEditDiagnostics({
          absolutePath: filePath,
          content: errorContent,
          rootId: 'r',
          rootPath: root,
        }),
        getEditDiagnostics({
          absolutePath: filePath,
          content: cleanContent,
          rootId: 'r',
          rootPath: root,
        }),
      ]);

      expect(errorResult.diagnostics?.some((d) => /not assignable/i.test(d.message))).toBe(true);
      expect(cleanResult.diagnostics ?? []).toEqual([]);
      // One pooled server served both (per-file lock, not per-call spawn).
      expect(countPooledLspServers()).toBe(1);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('inspects a symbol: hover type + definition location (report R2 Phase B)', async () => {
    const root = await makeRoot();
    try {
      // greeting is defined on line 1; used on line 2. Inspect the USE site.
      const content = 'export const greeting: string = "hi";\nexport const echo = greeting;\n';
      await fsPromises.writeFile(path.join(root, 'sym.ts'), content, 'utf8');

      // 0-based line 1 (the second line), cursor on `greeting` (char 20).
      const result = await getLspInspection({
        absolutePath: path.join(root, 'sym.ts'),
        content,
        position: { character: 20, line: 1 },
        rootId: 'root-1',
        rootPath: root,
      });

      expect(result.available).toBe(true);
      expect(result.language).toBe('typescript');
      // Hover reports the inferred type of `greeting`.
      expect(result.hover).toMatch(/greeting/);
      expect(result.hover).toMatch(/string/);
      // Definition points back to line 1 with a preview.
      expect(result.definition?.length ?? 0).toBeGreaterThan(0);
      const def = result.definition?.[0];
      expect(def?.path).toBe('/sym.ts');
      expect(def?.line).toBe(1);
      expect(def?.preview).toMatch(/greeting/);
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('lsp inspection degrades to an honest note for an unsupported language', async () => {
    const root = await makeRoot();
    try {
      await fsPromises.writeFile(path.join(root, 'notes.md'), '# hi\n', 'utf8');
      const result = await getLspInspection({
        absolutePath: path.join(root, 'notes.md'),
        content: '# hi\n',
        position: { character: 2, line: 0 },
        rootId: 'root-1',
        rootPath: root,
      });
      expect(result.available).toBe(false);
      expect(result.reason).toBe('unsupported-language');
      expect(countPooledLspServers()).toBe(0);
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
    expect(resolveBundledTsserverPath()).toMatch(/[/\\]typescript[/\\]lib[/\\]tsserver\.js$/);
  });
});
