import {
  type BoundaryResult,
  readBoundaryResult,
} from '@brainstrike/assistant-contract/boundary-result';
import type { LogRecord } from '@brainstrike/logging';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

interface ChunkingHostStatus {
  active: boolean;
  lastError: string | null;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface ParserRoutingProbe {
  languages: unknown;
  parseProbe: {
    error?: string;
    ok: boolean;
    root?: { type?: string };
  } | null;
  parserFlag: string | null;
  parseType: string;
}

interface SentenceChunkFileRequest {
  content: string;
  fileName: string;
  filePath: string;
  fileRecordId: string;
  kind: 'chunk-file';
  options: {
    forceStrategy: boolean;
    strategy: 'sentence';
  };
  requestId: string;
}

async function chunkSentenceFile(
  page: Page,
  request: SentenceChunkFileRequest
): Promise<{
  chunks: unknown[];
  skipped?: boolean;
  skipReason?: string;
}> {
  return await page.evaluate((chunkRequest) => {
    const api = (
      globalThis.window as Window & {
        chunkingHost?: {
          chunkFile?: (request: SentenceChunkFileRequest) => Promise<{
            chunks: unknown[];
            skipped?: boolean;
            skipReason?: string;
          }>;
        };
      }
    ).chunkingHost;
    if (!api?.chunkFile) {
      throw new Error('Chunking host bridge is not available');
    }
    return api.chunkFile(chunkRequest);
  }, request);
}

interface CodeChunkFileRequest {
  content: string;
  fileName: string;
  filePath: string;
  fileRecordId: string;
  kind: 'chunk-file';
  options: {
    forceStrategy: boolean;
    maxTokens: number;
    // Must be `requestedStrategy` (not `strategy`): the chunk-file IPC
    // validator (assertChunkingRequestOptions in chunking-host-shared.ts)
    // only reads `requestedStrategy`. 'recursive' + a code extension is what
    // drives the worker's chunkCode() → splitCodeByFunctions() AST path.
    requestedStrategy: 'recursive';
  };
  requestId: string;
}

async function chunkCodeFile(
  page: Page,
  request: CodeChunkFileRequest
): Promise<{
  chunks: Array<{ content: string }>;
  skipped: boolean;
  strategyUsed: string;
}> {
  return await page.evaluate((chunkRequest) => {
    const api = (
      globalThis.window as Window & {
        chunkingHost?: {
          chunkFile?: (request: CodeChunkFileRequest) => Promise<{
            chunks: Array<{ content: string }>;
            skipped: boolean;
            strategyUsed: string;
          }>;
        };
      }
    ).chunkingHost;
    if (!api?.chunkFile) {
      throw new Error('Chunking host bridge is not available');
    }
    return api.chunkFile(chunkRequest);
  }, request);
}

async function waitForAppReadyInTest(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
}

async function assertVisibleWindowResponsive(page: Page): Promise<void> {
  const assistantShell = page.getByTestId('assistant-chat-card');
  const workspaceToggle = page
    .getByTestId('show-workspace-panel')
    .or(page.getByTestId('hide-workspace-panel'));

  await expect(assistantShell).toBeVisible({ timeout: 10_000 });

  const domState = await page.evaluate(() => ({
    hasRoot: Boolean(document.getElementById('root')),
    readyState: document.readyState,
  }));
  expect(domState).toEqual({
    hasRoot: true,
    readyState: 'complete',
  });

  await expect(workspaceToggle.first()).toBeVisible({ timeout: 10_000 });
}

async function getChunkingHostStatus(page: Page): Promise<ChunkingHostStatus> {
  return await page.evaluate<ChunkingHostStatus>(async () => {
    const api = (
      window as Window & {
        chunkingHost?: {
          getStatus?: () => Promise<ChunkingHostStatus>;
        };
      }
    ).chunkingHost;
    if (!api?.getStatus) {
      throw new Error('Chunking host bridge is not available');
    }
    return await api.getStatus();
  });
}

async function getMainBufferedLogs(page: Page): Promise<
  Array<{
    bindings?: Record<string, unknown>;
    message?: string;
    scope?: string;
  }>
> {
  return readBoundaryResult(
    await page.evaluate(async () => {
      const loggingApi = (
        window as Window & {
          logging?: { getBufferedLogs: () => Promise<BoundaryResult<LogRecord[]>> };
        }
      ).logging;
      if (!loggingApi?.getBufferedLogs) {
        throw new Error('Logging bridge is not available');
      }
      return await loggingApi.getBufferedLogs();
    })
  );
}

test.describe('Chunking Host Renderer', () => {
  test.describe.configure({ mode: 'serial' });

  test('@desktop-runtime-hosts hidden chunking host can die without reloading the visible window', async ({
    electronApp,
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            ensureStarted?: () => Promise<ChunkingHostStatus>;
          };
        }
      ).chunkingHost;
      if (!api?.ensureStarted) {
        throw new Error('Chunking host bridge is not available');
      }
      await api.ensureStarted();
    });

    await expect
      .poll(async () => {
        const status = await getChunkingHostStatus(window);
        return status.state;
      })
      .toBe('running');

    await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const hostWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('mode=chunking-host')
      );
      if (!hostWindow) {
        throw new Error('Chunking host window was not found');
      }
      hostWindow.destroy();
    });

    await expect
      .poll(async () => {
        const status = await getChunkingHostStatus(window);
        return status.state;
      })
      .toBe('stopped');

    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('hidden chunking host logs are forwarded into the exported desktop log stream', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);

    await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            ensureStarted?: () => Promise<ChunkingHostStatus>;
          };
        }
      ).chunkingHost;
      if (!api?.ensureStarted) {
        throw new Error('Chunking host bridge is not available');
      }
      await api.ensureStarted();
    });

    await expect
      .poll(async () => {
        const logs = await getMainBufferedLogs(window);
        return logs.some(
          (record) =>
            record.message === 'Background renderer log forwarding enabled' &&
            record.bindings?.['sourceWindowRole'] === 'chunking-host'
        );
      })
      .toBe(true);
  });

  test('large chunking requests do not reload the visible window', async ({ window }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    const requestOutcome = await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            chunkFile?: (request: {
              fileRecordId: string;
              content: string;
              fileName: string;
              filePath: string;
              kind: 'chunk-file';
              options: {
                forceStrategy: boolean;
                strategy: 'sentence';
              };
              requestId: string;
            }) => Promise<{
              chunks: unknown[];
            }>;
          };
        }
      ).chunkingHost;
      if (!api?.chunkFile) {
        throw new Error('Chunking host bridge is not available');
      }

      const largeContent = Array.from(
        { length: 8192 },
        (_, index) => `Sentence ${index + 1} ends here.`
      ).join(' ');
      try {
        const result = await api.chunkFile({
          content: largeContent,
          fileName: 'large-import.txt',
          filePath: '/tmp/large-import.txt',
          fileRecordId: 'chunking-host-large-request',
          kind: 'chunk-file',
          options: {
            forceStrategy: true,
            strategy: 'sentence',
          },
          requestId: crypto.randomUUID(),
        });
        return { chunkCount: result.chunks.length, ok: true as const };
      } catch (error) {
        return {
          message: error instanceof Error ? error.message : String(error),
          ok: false as const,
        };
      }
    });

    expect(requestOutcome.ok).toBe(true);
    if (requestOutcome.ok) {
      expect(requestOutcome.chunkCount).toBeGreaterThan(0);
    }
    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('oversized chunking requests skip at file level without poisoning the hidden chunking host', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    const oversizedContent = 'x'.repeat(600 * 1024);
    const oversizedOutcome = await chunkSentenceFile(window, {
      content: oversizedContent,
      fileName: 'oversized-import.txt',
      filePath: '/tmp/oversized-import.txt',
      fileRecordId: 'chunking-host-oversized-request',
      kind: 'chunk-file',
      options: {
        forceStrategy: true,
        strategy: 'sentence',
      },
      requestId: crypto.randomUUID(),
    }).then(
      (result) => ({
        ok: true as const,
        skipped: result.skipped ?? false,
        skipReason: result.skipReason ?? null,
      }),
      (error: unknown) => ({
        message: error instanceof Error ? error.message : String(error),
        ok: false as const,
      })
    );

    expect(oversizedOutcome.ok).toBe(true);
    if (oversizedOutcome.ok) {
      expect(oversizedOutcome.skipped).toBe(true);
      expect(oversizedOutcome.skipReason).toContain('File too large');
    }

    const followupOutcome = await chunkSentenceFile(window, {
      content: Array.from(
        { length: 128 },
        (_, index) => `Follow-up line ${index + 1} after oversized request.`
      ).join('\n'),
      fileName: 'followup.txt',
      filePath: '/tmp/followup.txt',
      fileRecordId: 'chunking-host-followup-request',
      kind: 'chunk-file',
      options: {
        forceStrategy: true,
        strategy: 'sentence',
      },
      requestId: crypto.randomUUID(),
    }).then((result) => result.chunks.length);

    expect(followupOutcome).toBeGreaterThan(0);
    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('accepts non-legacy chunking strategies without reloading the visible window', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    const requestOutcome = await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            chunkFile?: (request: {
              fileRecordId: string;
              content: string;
              fileName: string;
              filePath: string;
              kind: 'chunk-file';
              options: {
                forceStrategy: boolean;
                strategy: 'character';
              };
              requestId: string;
            }) => Promise<{
              chunks: Array<{ content: string }>;
            }>;
          };
        }
      ).chunkingHost;
      if (!api?.chunkFile) {
        throw new Error('Chunking host bridge is not available');
      }

      const result = await api.chunkFile({
        content: Array.from(
          { length: 256 },
          (_, index) => `Line ${index + 1}: deterministic chunking host test content.`
        ).join('\n'),
        fileName: 'structured-notes.txt',
        filePath: '/tmp/structured-notes.txt',
        fileRecordId: 'chunking-host-character-request',
        kind: 'chunk-file',
        options: {
          forceStrategy: true,
          strategy: 'character',
        },
        requestId: crypto.randomUUID(),
      });

      return result.chunks.length;
    });

    expect(requestOutcome).toBeGreaterThan(0);
    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('@desktop-runtime-hosts chunking host engages the native oxc parser and tree-sitter routing', async ({
    electronApp,
    window,
  }) => {
    await waitForAppReadyInTest(window);

    await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            ensureStarted?: () => Promise<ChunkingHostStatus>;
          };
        }
      ).chunkingHost;
      if (!api?.ensureStarted) {
        throw new Error('Chunking host bridge is not available');
      }
      await api.ensureStarted();
    });

    await expect
      .poll(async () => {
        const status = await getChunkingHostStatus(window);
        return status.state;
      })
      .toBe('running');

    const probe = await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const hostWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('mode=chunking-host')
      );
      if (!hostWindow) {
        throw new Error('Chunking host window was not found');
      }
      // Runs in the chunking-host renderer's main world — the same realm the
      // bootstrap in renderer/main.tsx writes to and buildInitMessage reads
      // from before forwarding to the chunking worker.
      return (await hostWindow.webContents.executeJavaScript(`(async () => {
        const bridge = globalThis.parserHost;
        const parseType = typeof (bridge && bridge.parse);
        const flag = globalThis.__BRAINSTRIKE_PARSER_FLAG__;
        const languages = globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__;
        let parseProbe = null;
        if (parseType === 'function') {
          parseProbe = await bridge.parse({
            content: 'const answer: number = 42;',
            options: { errorRecovery: false, jsx: false, language: 'typescript' },
            requestId: crypto.randomUUID(),
          });
        }
        return {
          languages: Array.isArray(languages) ? Array.from(languages) : (languages ?? null),
          parseProbe,
          parseType,
          parserFlag: flag ?? null,
        };
      })()`)) as ParserRoutingProbe;
    });

    // A missing preload bridge would make buildInitMessage keep the worker on
    // its 'browser' default, silently downgrading desktop chunking to Babel.
    expect(probe.parseType).toBe('function');

    // Tree-sitter rollout default (#998 Phase 8): python enabled in the host.
    // Source of truth for this default is DEFAULT_ENABLED_LANGUAGES in
    // packages/chunking-worker/src/parsers/tree-sitter-rollout.ts (which is in
    // turn constrained to RECOGNIZED_TREE_SITTER_LANGUAGES in
    // packages/chunking-worker/src/parsers/environment.ts). Keep this literal
    // in sync when that rollout default changes.
    expect(probe.languages).toEqual(['python']);

    // The production host URL must not carry a stray kill switch.
    expect([null, 'auto']).toContain(probe.parserFlag);

    // The bridge round-trips through main IPC to the native oxc utility
    // process — proves the packaged binary actually parses.
    expect(
      probe.parseProbe?.ok,
      `oxc parse probe failed: ${probe.parseProbe?.error ?? 'no response'}`
    ).toBe(true);
    expect(probe.parseProbe?.root?.type).toBe('Program');

    // ── Runtime route coverage (PR #1641 review, chatgpt-codex P2) ────────
    // The probe above only proves preload → main IPC → utility-process
    // parsing. It does NOT prove the chunking *worker* routes through that
    // path. If buildInitMessage stopped forwarding parserEnv, or the
    // worker→renderer `parser-host:invoke` bridge broke, production chunking
    // would silently downgrade JS/TS to in-worker Babel while the probe still
    // passed. The drive below pushes a real chunkFile through the hidden
    // host's Web Worker so selectAdapter() actually runs and routes to oxc.

    // oxc route — a .ts file with several top-level functions. This is the
    // FIRST code parse in the worker's session (the preceding tests chunk only
    // .txt via the 'sentence'/'character' TEXT strategies, which never reach
    // selectAdapter), so the worker's one-shot first-parse audit reports the
    // adapter that actually handled it.
    const tsResult = await chunkCodeFile(window, {
      content: [
        'export function alpha(): number {',
        '  return 1;',
        '}',
        '',
        'export function bravo(): number {',
        '  return 2;',
        '}',
        '',
        'export function charlie(): number {',
        '  return 3;',
        '}',
        '',
      ].join('\n'),
      fileName: 'route-probe.ts',
      filePath: '/tmp/route-probe.ts',
      fileRecordId: 'chunking-host-oxc-route',
      kind: 'chunk-file',
      options: { forceStrategy: true, maxTokens: 2048, requestedStrategy: 'recursive' },
      requestId: crypto.randomUUID(),
    });

    expect(tsResult.skipped).toBe(false);
    expect(tsResult.strategyUsed).toBe('recursive');
    // AST chunking emits one chunk per top-level function. A broken
    // parser-host bridge would make oxc fail, and splitCodeByFunctions would
    // fall back to recursive TEXT splitting — which packs this sub-maxChars
    // file into a single chunk. So >1 proves the AST path ran.
    expect(tsResult.chunks.length).toBeGreaterThan(1);

    // The worker's first-parse audit is posted as a WorkerLog, forwarded
    // through the host renderer's log stream into the main buffered logs, and
    // names the adapter that ran. It reads "oxc-native" ONLY when
    // buildInitMessage set parserEnv=electron-chunking-host AND the
    // parser-host:invoke bridge round-tripped to the native oxc utility
    // process. If parserEnv were unset the worker would keep its 'browser'
    // default and the audit would name "babel" instead — so this assertion
    // distinguishes the oxc IPC route from a silent Babel downgrade.
    await expect
      .poll(async () => {
        const logs = await getMainBufferedLogs(window);
        return logs.some(
          (record) =>
            typeof record.message === 'string' &&
            record.message.includes('first parse succeeded using adapter "oxc-native"')
        );
      })
      .toBe(true);

    // NOTE on tree-sitter (Python): the previously-omitted worker-driven
    // assertion now lives in the dedicated test below. It was omitted because
    // tree-sitter Python threw at parse time in the packaged desktop worker
    // (Vite rewrote the grammar-WASM `new URL(..., import.meta.url)` into a
    // 404) and silently fell back to recursive splitting. That runtime bug is
    // fixed — the grammar URL now resolves at runtime; see
    // packages/chunking-worker/src/parsers/tree-sitter-grammar-loader.ts — so
    // the result is asserted directly below.
  });

  test('@desktop-runtime-hosts structure-aware Python chunking uses the tree-sitter adapter in the packaged worker', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    // tree-sitter route — a .py file with several top-level definitions. Kept
    // well under the recursive splitter's chunk size on purpose: the AST path
    // emits one chunk per top-level definition (>1 chunk), whereas a silent
    // fall back to recursive TEXT splitting (the grammar-WASM URL regression
    // this guards) packs the whole sub-maxChars file into a SINGLE chunk. Chunk
    // count is therefore a direct behavioral discriminator between "tree-sitter
    // parsed" and "fell back".
    //
    // Unlike the oxc test above, this does NOT assert the first-parse audit
    // log: that audit fires exactly once per worker lifetime and the preceding
    // oxc .ts drive (same serial worker session) already consumed it as
    // "oxc-native". The chunk-count discriminator is order-independent and
    // catches the same regression.
    const pyResult = await chunkCodeFile(window, {
      content: [
        'def alpha(value):',
        '    """Double the input."""',
        '    return value * 2',
        '',
        '',
        'def beta(value):',
        '    """Square the input."""',
        '    return value * value',
        '',
        '',
        'def gamma(items):',
        '    total = 0',
        '    for item in items:',
        '        total += item',
        '    return total',
        '',
        '',
        'class Delta:',
        '    def method_one(self):',
        '        return 1',
        '',
        '    def method_two(self):',
        '        return 2',
        '',
        '',
        'def epsilon():',
        '    return Delta()',
        '',
      ].join('\n'),
      fileName: 'structure-aware.py',
      filePath: '/tmp/structure-aware.py',
      fileRecordId: 'chunking-host-tree-sitter-route',
      kind: 'chunk-file',
      options: { forceStrategy: true, maxTokens: 2048, requestedStrategy: 'recursive' },
      requestId: crypto.randomUUID(),
    });

    expect(pyResult.skipped).toBe(false);
    expect(pyResult.strategyUsed).toBe('recursive');
    // AST chunking emits one chunk per top-level definition. A grammar-load
    // failure would throw in the worker and fall back to recursive TEXT
    // splitting, collapsing this small file to a single chunk. So >1 proves
    // the tree-sitter AST path actually ran.
    expect(pyResult.chunks.length).toBeGreaterThan(1);

    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('supports accurate token sizing in the hidden chunking host without crashing the visible window', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    const requestOutcome = await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            chunkFile?: (request: {
              fileRecordId: string;
              content: string;
              fileName: string;
              filePath: string;
              kind: 'chunk-file';
              options: {
                forceStrategy: boolean;
                strategy: 'sentence';
                tokenTrueSizing: true;
              };
              requestId: string;
            }) => Promise<{
              chunks: Array<{ tokenCount: number }>;
              totalTokens: number;
            }>;
          };
        }
      ).chunkingHost;
      if (!api?.chunkFile) {
        throw new Error('Chunking host bridge is not available');
      }

      try {
        const result = await api.chunkFile({
          content: Array.from(
            { length: 128 },
            (_, index) => `Deterministic accurate token sizing line ${index + 1}.`
          ).join('\n'),
          fileName: 'accurate-token-host.txt',
          filePath: '/tmp/accurate-token-host.txt',
          fileRecordId: 'chunking-host-accurate-token-request',
          kind: 'chunk-file',
          options: {
            forceStrategy: true,
            strategy: 'sentence',
            tokenTrueSizing: true,
          },
          requestId: crypto.randomUUID(),
        });
        return {
          chunkCount: result.chunks.length,
          minTokenCount:
            result.chunks.length > 0
              ? Math.min(...result.chunks.map((chunk) => chunk.tokenCount))
              : 0,
          ok: true as const,
          totalTokens: result.totalTokens,
        };
      } catch (error) {
        return {
          message: error instanceof Error ? error.message : String(error),
          ok: false as const,
        };
      }
    });

    expect(requestOutcome.ok).toBe(true);
    if (requestOutcome.ok) {
      expect(requestOutcome.chunkCount).toBeGreaterThan(0);
      expect(requestOutcome.totalTokens).toBeGreaterThan(0);
      expect(requestOutcome.minTokenCount).toBeGreaterThan(0);
    }
    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });
});
