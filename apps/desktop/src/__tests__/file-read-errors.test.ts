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
const PRELOAD_PATH = path.resolve(import.meta.dirname, '..', 'preload.ts');

interface PreloadFileReadErrorContract {
  readonly notFoundCode: string;
  readonly predicate: (value: unknown) => boolean;
  readonly tooLargeCode: string;
}

function extractConstString(source: string, name: string): string {
  const match = new RegExp(`const ${name} = '([^']+)' as const;`).exec(source);
  if (!match?.[1]) {
    throw new Error(`Preload constant ${name} was not found.`);
  }
  return match[1];
}

function extractFunctionDeclaration(source: string, name: string): string {
  const functionStart = source.indexOf(`function ${name}`);
  const bodyStart = source.indexOf('{', functionStart);
  if (functionStart < 0 || bodyStart < 0) {
    throw new Error(`Preload function ${name} was not found.`);
  }

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(functionStart, index + 1);
      }
    }
  }
  throw new Error(`Preload function ${name} has an unbalanced body.`);
}

function loadPreloadFileReadErrorContract(
  preloadSource = readFileSync(PRELOAD_PATH, 'utf8')
): PreloadFileReadErrorContract {
  const tooLargeCode = extractConstString(preloadSource, 'FILE_READ_ERROR_CODE_TOO_LARGE');
  const notFoundCode = extractConstString(preloadSource, 'FILE_READ_ERROR_CODE_NOT_FOUND');
  if (tooLargeCode !== FILE_READ_ERROR_CODE_TOO_LARGE) {
    throw new Error('Preload TOO_LARGE code differs from the canonical contract.');
  }
  if (notFoundCode !== FILE_READ_ERROR_CODE_NOT_FOUND) {
    throw new Error('Preload NOT_FOUND code differs from the canonical contract.');
  }

  const predicateSource = extractFunctionDeclaration(preloadSource, 'isFileReadErrorPayload');
  const executableSource = transpileModule(
    `
      const FILE_READ_ERROR_CODE_TOO_LARGE = ${JSON.stringify(tooLargeCode)};
      const FILE_READ_ERROR_CODE_NOT_FOUND = ${JSON.stringify(notFoundCode)};
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
  return {
    notFoundCode,
    predicate: predicate as (value: unknown) => boolean,
    tooLargeCode,
  };
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
    const preloadContract = loadPreloadFileReadErrorContract();
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

    expect(preloadContract.tooLargeCode).toBe(FILE_READ_ERROR_CODE_TOO_LARGE);
    expect(preloadContract.notFoundCode).toBe(FILE_READ_ERROR_CODE_NOT_FOUND);
    expect(candidates.map(preloadContract.predicate)).toEqual(
      candidates.map(isFileReadErrorPayload)
    );
  });

  it('rejects drift in the preload duplicated constant values', () => {
    const preloadSource = readFileSync(PRELOAD_PATH, 'utf8');
    const driftedSource = preloadSource.replace(
      "const FILE_READ_ERROR_CODE_TOO_LARGE = 'TOO_LARGE' as const;",
      "const FILE_READ_ERROR_CODE_TOO_LARGE = 'FILE_TOO_LARGE' as const;"
    );

    expect(() => loadPreloadFileReadErrorContract(driftedSource)).toThrow(
      'Preload TOO_LARGE code differs from the canonical contract.'
    );
  });

  it('cross-references the intentional preload duplication in both implementations', () => {
    const preloadSource = readFileSync(PRELOAD_PATH, 'utf8');
    const canonicalSource = readFileSync(
      path.resolve(import.meta.dirname, '..', 'file-read-errors.ts'),
      'utf8'
    );

    expect(preloadSource).toContain(PRELOAD_DUPLICATE_CONTRACT_ANCHOR);
    expect(preloadSource).toMatch(
      /BST-338 preload duplicate contract:[\s\S]{0,300}const FILE_READ_ERROR_CODE_TOO_LARGE/
    );
    expect(canonicalSource).toContain(PRELOAD_DUPLICATE_CONTRACT_ANCHOR);
  });
});
