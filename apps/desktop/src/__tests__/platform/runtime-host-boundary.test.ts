import { describe, expect, it } from 'vitest';
import {
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

  it('keeps current desktop source free of runtime-host boundary violations', () => {
    expect(findRuntimeHostBoundaryViolationsInDesktopSource()).toEqual([]);
  });
});
