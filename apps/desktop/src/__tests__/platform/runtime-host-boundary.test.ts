import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectDesktopSourceFiles,
  findRuntimeHostBoundaryViolations,
  findRuntimeHostBoundaryViolationsInDesktopSource,
} from '../../platform/runtime-host-boundary';

describe('runtime host boundary', () => {
  it('allows renderer host modules to import renderer-only local runtimes', () => {
    const violations = findRuntimeHostBoundaryViolations([
      {
        path: 'apps/desktop/src/renderer/components/llm-host-runtime.tsx',
        source: "import { LocalLlmBackend } from '@brainstrike/agent/local-llm';",
      },
      {
        path: 'apps/desktop/src/renderer/components/embedding-host-runtime.tsx',
        source: "import { startEmbeddingWorker } from '@brainstrike/embeddings/worker';",
      },
    ]);

    expect(violations).toEqual([]);
  });

  it('allows shared main contracts to import renderer-only runtime types only', () => {
    const violations = findRuntimeHostBoundaryViolations([
      {
        path: 'apps/desktop/src/llm-host-shared.ts',
        source: "import type { LocalLlmGenerationResult } from '@brainstrike/agent/local-llm';",
      },
    ]);

    expect(violations).toEqual([]);
  });

  it('rejects Electron main imports that can execute renderer-only local runtimes', () => {
    const violations = findRuntimeHostBoundaryViolations([
      {
        path: 'apps/desktop/src/main.ts',
        source: "import { LocalLlmBackend } from '@brainstrike/agent/local-llm';",
      },
      {
        path: 'apps/desktop/src/ipc-handlers.ts',
        source: "import { startEmbeddingWorker } from '@brainstrike/embeddings/worker';",
      },
    ]);

    expect(violations).toEqual([
      {
        importSource: '@brainstrike/agent/local-llm',
        message:
          'Built-in local LLM execution is renderer-only; Electron main must talk to llm-host.',
        path: 'apps/desktop/src/main.ts',
      },
      {
        importSource: '@brainstrike/embeddings/worker',
        message:
          'Local embedding worker execution is renderer-only; Electron main must talk to embedding-host.',
        path: 'apps/desktop/src/ipc-handlers.ts',
      },
    ]);
  });

  it('rejects dynamic imports and require calls that can execute renderer-only local runtimes', () => {
    const violations = findRuntimeHostBoundaryViolations([
      {
        path: 'apps/desktop/src/main.ts',
        source:
          "async function loadLocalRuntime() { return import('@brainstrike/agent/local-llm'); }",
      },
      {
        path: 'apps/desktop/src/ipc-handlers.ts',
        source: "const embeddingWorker = require('@brainstrike/embeddings/worker');",
      },
    ]);

    expect(violations).toEqual([
      {
        importSource: '@brainstrike/agent/local-llm',
        message:
          'Built-in local LLM execution is renderer-only; Electron main must talk to llm-host.',
        path: 'apps/desktop/src/main.ts',
      },
      {
        importSource: '@brainstrike/embeddings/worker',
        message:
          'Local embedding worker execution is renderer-only; Electron main must talk to embedding-host.',
        path: 'apps/desktop/src/ipc-handlers.ts',
      },
    ]);
  });

  it('rejects re-exports that can execute renderer-only local runtimes', () => {
    const violations = findRuntimeHostBoundaryViolations([
      {
        path: 'apps/desktop/src/main.ts',
        source: "export { LocalLlmBackend } from '@brainstrike/agent/local-llm';",
      },
      {
        path: 'apps/desktop/src/ipc-handlers.ts',
        source: "export * from '@brainstrike/embeddings/worker';",
      },
    ]);

    expect(violations).toEqual([
      {
        importSource: '@brainstrike/agent/local-llm',
        message:
          'Built-in local LLM execution is renderer-only; Electron main must talk to llm-host.',
        path: 'apps/desktop/src/main.ts',
      },
      {
        importSource: '@brainstrike/embeddings/worker',
        message:
          'Local embedding worker execution is renderer-only; Electron main must talk to embedding-host.',
        path: 'apps/desktop/src/ipc-handlers.ts',
      },
    ]);
  });

  it('keeps current desktop source free of runtime-host boundary violations', () => {
    expect(findRuntimeHostBoundaryViolationsInDesktopSource()).toEqual([]);
  });

  it('skips symlinked entries while collecting desktop source files', () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-runtime-boundary-'));
    const externalRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-runtime-boundary-external-'));

    try {
      const sourceRoot = path.join(temporaryRoot, 'src');
      mkdirSync(sourceRoot);
      writeFileSync(path.join(sourceRoot, 'main.ts'), "import './safe';", 'utf8');
      writeFileSync(
        path.join(externalRoot, 'outside.ts'),
        "import '@brainstrike/agent/local-llm';",
        'utf8'
      );
      symlinkSync(path.join(externalRoot, 'outside.ts'), path.join(sourceRoot, 'outside.ts'));

      expect(collectDesktopSourceFiles(sourceRoot)).toEqual([
        {
          path: path.relative(process.cwd(), path.join(sourceRoot, 'main.ts')),
          source: "import './safe';",
        },
      ]);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
      rmSync(externalRoot, { force: true, recursive: true });
    }
  });
});
