import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createContext, Script } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createFileReadErrorPayload,
  FILE_READ_ERROR_CODE_NOT_FOUND,
  FILE_READ_ERROR_CODE_TOO_LARGE,
  isFileReadErrorPayload,
} from '../file-read-errors';

const PRELOAD_DUPLICATE_CONTRACT_ANCHOR = 'BST-338 preload duplicate contract';

function loadPreloadFileReadErrorPredicate(): (value: unknown) => boolean {
  const preloadSource = readFileSync(path.resolve(process.cwd(), 'src', 'preload.ts'), 'utf8');
  const functionStart = preloadSource.indexOf('function isFileReadErrorPayload');
  const functionEndMarker = '\n}\n\nfunction unwrapFileReadResult';
  const functionEnd = preloadSource.indexOf(functionEndMarker, functionStart);
  if (functionStart < 0 || functionEnd < 0) {
    throw new Error('Preload file-read payload predicate was not found.');
  }

  const predicateSource = preloadSource.slice(functionStart, functionEnd + 2);
  const executableSource = transpileModule(
    `
      const FILE_READ_ERROR_CODE_TOO_LARGE = ${JSON.stringify(FILE_READ_ERROR_CODE_TOO_LARGE)};
      const FILE_READ_ERROR_CODE_NOT_FOUND = ${JSON.stringify(FILE_READ_ERROR_CODE_NOT_FOUND)};
      ${predicateSource}
      globalThis.__fileReadPredicate = isFileReadErrorPayload;
    `,
    {
      compilerOptions: {
        module: ModuleKind.None,
        target: ScriptTarget.ES2022,
      },
    }
  ).outputText;
  const context = createContext({});
  new Script(executableSource).runInContext(context);
  const predicate = (context as { __fileReadPredicate?: unknown }).__fileReadPredicate;
  if (typeof predicate !== 'function') {
    throw new Error('Preload file-read payload predicate did not evaluate to a function.');
  }
  return predicate as (value: unknown) => boolean;
}

describe('file-read-errors', () => {
  it('creates the canonical file read error payload', () => {
    expect(createFileReadErrorPayload('Too large')).toEqual({
      code: FILE_READ_ERROR_CODE_TOO_LARGE,
      message: 'Too large',
    });
  });

  it('accepts only the strict file read error payload shape', () => {
    expect(
      isFileReadErrorPayload({
        code: FILE_READ_ERROR_CODE_TOO_LARGE,
        message: 'Too large',
      })
    ).toBe(true);
    expect(isFileReadErrorPayload(null)).toBe(false);
    expect(isFileReadErrorPayload('nope')).toBe(false);
    expect(isFileReadErrorPayload({ code: 'OTHER', message: 'Too large' })).toBe(false);
    expect(
      isFileReadErrorPayload({
        code: FILE_READ_ERROR_CODE_TOO_LARGE,
        message: 123,
      })
    ).toBe(false);
  });

  it('keeps the sandboxed preload predicate in semantic parity with the canonical guard', () => {
    const preloadPredicate = loadPreloadFileReadErrorPredicate();
    const candidates: unknown[] = [
      null,
      'nope',
      {},
      { code: 'OTHER', message: 'Too large' },
      { code: FILE_READ_ERROR_CODE_TOO_LARGE, message: 'Too large' },
      { code: FILE_READ_ERROR_CODE_NOT_FOUND, message: 'Missing' },
      { code: FILE_READ_ERROR_CODE_TOO_LARGE, message: 123 },
      { code: FILE_READ_ERROR_CODE_NOT_FOUND, message: '' },
    ];

    expect(candidates.map(preloadPredicate)).toEqual(candidates.map(isFileReadErrorPayload));
  });

  it('cross-references the intentional preload duplication in both implementations', () => {
    const preloadSource = readFileSync(path.resolve(process.cwd(), 'src', 'preload.ts'), 'utf8');
    const canonicalSource = readFileSync(
      path.resolve(process.cwd(), 'src', 'file-read-errors.ts'),
      'utf8'
    );

    expect(preloadSource).toContain(PRELOAD_DUPLICATE_CONTRACT_ANCHOR);
    expect(canonicalSource).toContain(PRELOAD_DUPLICATE_CONTRACT_ANCHOR);
  });
});
