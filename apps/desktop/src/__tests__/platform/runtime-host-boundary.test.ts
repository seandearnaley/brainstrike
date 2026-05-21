import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectDesktopSourceFiles,
  findRuntimeHostBoundaryViolations,
  findRuntimeHostBoundaryViolationsInDesktopSource,
} from '../../platform/runtime-host-boundary';

function readDesktopSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8');
}

function readDesktopE2e(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), 'e2e', relativePath), 'utf8');
}

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
      {
        path: 'apps/desktop/src/assistant-server/retrieval-tool.ts',
        source: "import { OpenAIEmbeddingProvider } from '@brainstrike/embeddings';",
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
      {
        importSource: '@brainstrike/embeddings',
        message:
          'The embeddings root entrypoint exports renderer-only worker execution; Electron main must import hosted provider contracts from @brainstrike/embeddings/provider-core.',
        path: 'apps/desktop/src/assistant-server/retrieval-tool.ts',
      },
    ]);
  });

  it('rejects Electron main imports below renderer-only runtime entrypoints', () => {
    const violations = findRuntimeHostBoundaryViolations([
      {
        path: 'apps/desktop/src/main.ts',
        source: "import { LocalLlmBackend } from '@brainstrike/agent/local-llm/internal';",
      },
      {
        path: 'apps/desktop/src/ipc-handlers.ts',
        source: "import { startEmbeddingWorker } from '@brainstrike/embeddings/worker/runtime';",
      },
      {
        path: 'apps/desktop/src/assistant-server/retrieval-tool.ts',
        source:
          "import { resolveHostedProviderApiKey } from '@brainstrike/embeddings/provider-core';",
      },
    ]);

    expect(violations).toEqual([
      {
        importSource: '@brainstrike/agent/local-llm/internal',
        message:
          'Built-in local LLM execution is renderer-only; Electron main must talk to llm-host.',
        path: 'apps/desktop/src/main.ts',
      },
      {
        importSource: '@brainstrike/embeddings/worker/runtime',
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

  it('keeps the root IPC handler as a registry over owned platform modules', () => {
    const source = readDesktopSource('ipc-handlers.ts');

    expect(source.split('\n').length).toBeLessThanOrEqual(1500);
    expect(source).toMatch(/ipc-domains\/db-ipc/);
    expect(source).toMatch(/ipc-domains\/embedding-backfill-ipc/);
    expect(source).toMatch(/ipc-domains\/file-system-ipc/);
    expect(source).toMatch(/ipc-domains\/storage-preferences-ipc/);
  });

  it('keeps main process startup free of ad hoc IPC registration', () => {
    const source = readDesktopSource('main.ts');

    expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
    expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
  });

  it('keeps host IPC modules on the typed desktop IPC registry instead of direct ipcMain calls', () => {
    const hostSources = [
      readDesktopSource('ipc-embedding-host.ts'),
      readDesktopSource('ipc-chunking-host.ts'),
      readDesktopSource('ipc-llm-host.ts'),
      readDesktopSource('ipc-parser-host.ts'),
    ];

    for (const source of hostSources) {
      expect(source).toMatch(
        /createDesktopIpcRegistry|registerBackgroundRuntimeLifecycleIpcHandlers/
      );
      expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
      expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
    }
  });

  it('keeps runtime lifecycle IPC domain ownership explicit', () => {
    const lifecycleSource = readDesktopSource('register-background-runtime-lifecycle-ipc.ts');
    const hostSources = [
      readDesktopSource('ipc-embedding-host.ts'),
      readDesktopSource('ipc-chunking-host.ts'),
      readDesktopSource('ipc-llm-host.ts'),
    ];

    expect(lifecycleSource).not.toMatch(/inferLifecycleDomain/);
    expect(lifecycleSource).not.toMatch(/domain\?:/);
    for (const source of hostSources) {
      expect(source).toMatch(/domain:\s*['"][^'"]+['"]/);
    }
  });

  it('keeps desktop IPC database tests split by owned responsibility', () => {
    const databaseIpcTest = readDesktopSource('__tests__/main/ipc-handlers-db.test.ts');
    const embeddingBackfillIpcTest = readDesktopSource(
      '__tests__/main/ipc-handlers-db-embedding-backfill.test.ts'
    );

    expect(databaseIpcTest.split('\n').length).toBeLessThanOrEqual(2000);
    expect(embeddingBackfillIpcTest).toMatch(/embedding-host:enqueue-backfill/);
    expect(embeddingBackfillIpcTest.split('\n').length).toBeLessThanOrEqual(2000);
  });

  it('keeps desktop file explorer selection E2E executable specs split by purpose', () => {
    const interactiveSpec = readDesktopE2e('file-explorer-selection.desktop.test.ts');
    const restoreSpec = readDesktopE2e('file-explorer-selection-restore.desktop.test.ts');
    const sharedHarness = readDesktopE2e('README.md');

    expect(interactiveSpec.split('\n').length).toBeLessThanOrEqual(2000);
    expect(restoreSpec.split('\n').length).toBeLessThanOrEqual(2000);
    expect(sharedHarness).toMatch(/file-explorer-selection\.shared\.ts/);
    expect(sharedHarness).toMatch(/test fixture\s+exception/);
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
          path: 'src/main.ts',
          source: "import './safe';",
        },
      ]);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
      rmSync(externalRoot, { force: true, recursive: true });
    }
  });
});
