import type { CodeLanguage } from './chunking-config';
import { type ExtractedSymbols, extractSymbols } from './extract-symbols';
import { getEnabledTreeSitterLanguages } from './parsers/environment';
import { selectAdapter } from './parsers/select-adapter';
import type { AstNode, ParserAdapter } from './parsers/types';

/** Host-local parser capability; never serialized as worker request options. */
export interface CanonicalChunkingRuntime {
  readonly enabledTreeSitterLanguages: readonly string[];
  readonly selectAdapter: (fileName?: string) => ParserAdapter | null;
  readonly strict: boolean;
}

// Module-scoped flag for the one-shot "first parse audit" — see the
// auditFirstSuccessfulParse() helper below.
let auditFired = false;
function auditFirstSuccessfulParse(adapterId: string): void {
  if (auditFired) {
    return;
  }
  auditFired = true;
  const message = `[chunking-parser] first parse succeeded using adapter "${adapterId}" — IPC chain confirmed`;
  // When running inside the chunking Web Worker, post a WorkerLog message
  // so the parent (file-import's chunking-worker-port) can forward it
  // through the project's logger system at info level. That makes the
  // audit visible in the unified `pnpm dev` output without requiring
  // the operator to open the chunking-host renderer's DevTools.
  // Falls back to console.info for non-worker contexts (unit tests,
  // direct use from a non-Electron browser).
  const workerSelf = (globalThis as { self?: { postMessage?: (msg: unknown) => void } }).self;
  if (
    workerSelf &&
    typeof workerSelf.postMessage === 'function' &&
    (globalThis as { window?: unknown }).window !== workerSelf
  ) {
    try {
      workerSelf.postMessage({ level: 'info', message, type: 'log' });
      return;
    } catch {
      // structured-clone or transport failure — fall through to console
    }
  }
  // biome-ignore lint/suspicious/noConsole: one-time operational signal
  console.info(message);
}

export function supportsCanonicalAst(
  language: CodeLanguage | null,
  runtime?: CanonicalChunkingRuntime
): boolean {
  if (language === 'typescript' || language === 'javascript') {
    return true;
  }
  if (language !== 'python') {
    return false;
  }
  if (runtime?.strict) {
    return true;
  }
  return (runtime?.enabledTreeSitterLanguages ?? getEnabledTreeSitterLanguages()).includes(
    'python'
  );
}

export async function parseCanonicalSource(
  content: string,
  language: CodeLanguage | null,
  fileName: string | undefined,
  runtime?: CanonicalChunkingRuntime
): Promise<{ ast: AstNode; symbols: ExtractedSymbols | null } | null> {
  let ast: AstNode | null = null;
  const adapter = runtime ? runtime.selectAdapter(fileName) : selectAdapter(fileName);
  if (adapter === null) {
    if (runtime?.strict) {
      throw new Error(`No canonical AST adapter for ${fileName ?? 'unnamed source'}.`);
    }
    // selectAdapter returned null (Phase 9 strict): the file is not
    // AST-chunkable in this configuration. Most common case: a .py file
    // with tree-sitter Python disabled. We log at warn (same level as
    // parse failures) and return null so the chunker falls back to the
    // recursive splitter — the loud-degrade pattern from PRD §8.2.
    // biome-ignore lint/suspicious/noConsole: visible signal that AST chunking is skipped
    console.warn(
      '[portable-chunking] No AST adapter for file; falling back to recursive splitting',
      {
        fileName,
        language,
      }
    );
    return null;
  }
  try {
    ast = await adapter.parse(content, {
      errorRecovery: true,
      jsx: true,
      language: language === 'typescript' ? 'typescript' : 'javascript',
    });
    // First-parse audit (logs once per worker session). This is the
    // operator's confirmation that selectAdapter picked the right adapter
    // AND that the first parse round-trip actually completed — without
    // this, "no errors in the log" is ambiguous between "oxc works" and
    // "oxc is silently bypassed." After the first successful parse the
    // audit goes silent so the log isn't spammy.
    auditFirstSuccessfulParse(adapter.id);
  } catch (err) {
    if (runtime?.strict) {
      throw err;
    }
    // WARN level (not debug): an AST parse failure means function-aware
    // chunking degraded to non-AST recursive splitting for this file.
    // That's a meaningful quality regression for code retrieval, and a
    // sustained pattern (e.g., every file failing) indicates the parser
    // is broken — which we want LOUD, not hidden. The caller-side
    // catch returns null so the pipeline still produces chunks via
    // the recursive splitter; this log is the signal that we paid a
    // quality cost to do so.
    // biome-ignore lint/suspicious/noConsole: visible signal for parser quality regression
    console.warn('[portable-chunking] AST parsing failed; falling back to recursive splitting', {
      contentLength: content.length,
      error: err instanceof Error ? err.message : String(err),
      language,
    });
    return null;
  }

  // Symbol extraction rides the SAME parse (BST-919): the AST is in hand and
  // both index paths converge here, so there is no separate walker. An
  // extractor error degrades LOUDLY to chunks-without-symbols — extraction
  // must never fail chunking.
  let symbols: ExtractedSymbols | null = null;
  try {
    symbols = extractSymbols({ adapterId: adapter.id, ast, content });
  } catch (err) {
    if (runtime?.strict) {
      throw err;
    }
    // biome-ignore lint/suspicious/noConsole: visible signal that the symbol graph lost this file
    console.warn(
      '[portable-chunking] symbol extraction failed; chunking continues without symbols',
      {
        error: err instanceof Error ? err.message : String(err),
        fileName,
      }
    );
  }

  return { ast, symbols };
}
