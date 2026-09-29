import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

function parseScriptArguments(script: string): string[] {
  return script.split(/\s+/u).map((argument) => argument.replace(/^["']|["']$/gu, ''));
}

function hasExactArgument(script: string, argument: string): boolean {
  return parseScriptArguments(script).includes(argument);
}

function hasFileParallelismArgument(script: string): boolean {
  return parseScriptArguments(script).some((argument) => {
    const [name] = argument.split('=');
    return name === '--fileParallelism' || name === '--file-parallelism';
  });
}

function hasPoolArgument(script: string): boolean {
  return parseScriptArguments(script).some(
    (argument) => argument === '--pool' || argument.startsWith('--pool=')
  );
}

function configArguments(script: string): string[] {
  return parseScriptArguments(script).filter((argument) => {
    const [name] = argument.split('=');
    return name === '--config' || name === '-c';
  });
}

function maxWorkerArguments(script: string): string[] {
  return parseScriptArguments(script).filter((argument) => {
    const [name] = argument.split('=');
    return name === '--maxWorkers' || name === '--max-workers';
  });
}

const VALUE_ARGUMENTS = new Set([
  '--config',
  '--exclude',
  '--file-parallelism',
  '--fileParallelism',
  '--max-workers',
  '--maxWorkers',
  '--pool',
  '-c',
]);

function positionalFilters(script: string): string[] {
  const argumentsAfterCommand = parseScriptArguments(script).slice(2);
  const filters: string[] = [];
  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) {
      continue;
    }
    if (VALUE_ARGUMENTS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) {
      continue;
    }
    filters.push(argument);
  }
  return filters;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('embedding queue load harness contract', () => {
  const packageRoot = path.resolve(import.meta.dirname, '../..');
  const harnessPath = path.resolve(
    packageRoot,
    'src/__tests__/embedding-queue-load.integration.test.ts'
  );
  const integrationConfigPath = path.resolve(packageRoot, 'vitest.integration.config.mts');
  const packageJsonPath = path.resolve(packageRoot, 'package.json');

  it('keeps the load harness in the serialized integration lane', async () => {
    expect(existsSync(harnessPath)).toBe(true);

    const configUrl = pathToFileURL(integrationConfigPath).href;
    const configModule: unknown = await import(configUrl);
    if (!(isRecord(configModule) && isRecord(configModule['default']))) {
      throw new Error('Expected the embeddings integration Vitest config to export an object.');
    }
    const effectiveTestConfig = configModule['default']['test'];
    if (!isRecord(effectiveTestConfig)) {
      throw new Error('Expected the embeddings integration Vitest config to define test options.');
    }
    const includePatterns = effectiveTestConfig['include'];
    const excludePatterns = effectiveTestConfig['exclude'];
    if (
      !(
        Array.isArray(includePatterns) &&
        includePatterns.every((pattern) => typeof pattern === 'string') &&
        Array.isArray(excludePatterns) &&
        excludePatterns.every((pattern) => typeof pattern === 'string')
      )
    ) {
      throw new Error('Expected the embeddings integration Vitest config to define string globs.');
    }
    expect(configModule['default']['root']).toBeUndefined();
    expect(effectiveTestConfig['dir']).toBeUndefined();
    expect(effectiveTestConfig['projects']).toBeUndefined();
    expect(includePatterns).toEqual(['**/*.integration.test.*']);
    expect(excludePatterns).toEqual(['**/node_modules/**', '**/dist/**', '**/*.models.test.*']);
    const harnessRelativePath = path.relative(packageRoot, harnessPath).split(path.sep).join('/');
    expect(includePatterns.some((pattern) => path.matchesGlob(harnessRelativePath, pattern))).toBe(
      true
    );
    expect(excludePatterns.some((pattern) => path.matchesGlob(harnessRelativePath, pattern))).toBe(
      false
    );
    expect(effectiveTestConfig['pool']).toBe('forks');

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: { test?: unknown; 'test:integration'?: unknown };
    };
    const pureScript = packageJson.scripts?.['test'];
    if (typeof pureScript !== 'string') {
      throw new Error('Expected @brainstrike/embeddings to define a test script.');
    }
    const pureArguments = parseScriptArguments(pureScript);
    const pureExcludeIndex = pureArguments.indexOf('--exclude');
    expect(pureArguments.filter((argument) => argument === '--exclude')).toHaveLength(1);
    expect(pureArguments.at(pureExcludeIndex + 1)).toBe('**/*.integration.test.*');

    const integrationScript = packageJson.scripts?.['test:integration'];
    if (typeof integrationScript !== 'string') {
      throw new Error('Expected @brainstrike/embeddings to define a test:integration script.');
    }
    const integrationArguments = parseScriptArguments(integrationScript);
    expect(integrationArguments).toEqual([
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.mts',
      '--maxWorkers=1',
      '--no-file-parallelism',
    ]);
    const integrationConfigIndex = integrationArguments.indexOf('--config');
    expect(configArguments(integrationScript)).toEqual(['--config']);
    expect(configArguments(`${integrationScript} --config=vitest.models.config.mts`)).toHaveLength(
      2
    );
    expect(configArguments(`${integrationScript} -c=vitest.models.config.mts`)).toHaveLength(2);
    expect(integrationArguments.at(integrationConfigIndex + 1)).toBe(
      'vitest.integration.config.mts'
    );
    expect(maxWorkerArguments(integrationScript)).toEqual(['--maxWorkers=1']);
    expect(maxWorkerArguments(`${integrationScript} --maxWorkers=10`)).toHaveLength(2);
    expect(maxWorkerArguments(`${integrationScript} --max-workers=10`)).toHaveLength(2);
    expect(positionalFilters(integrationScript)).toEqual([]);
    expect(
      positionalFilters(`${integrationScript} src/__tests__/embedding-worker.integration.test.ts`)
    ).toEqual(['src/__tests__/embedding-worker.integration.test.ts']);
    expect(hasExactArgument(integrationScript, '--no-file-parallelism')).toBe(true);
    expect(hasFileParallelismArgument(integrationScript)).toBe(false);
    expect(hasFileParallelismArgument(`${integrationScript} --fileParallelism`)).toBe(true);
    expect(hasFileParallelismArgument(`${integrationScript} --fileParallelism=true`)).toBe(true);
    expect(hasFileParallelismArgument(`${integrationScript} --file-parallelism`)).toBe(true);
    expect(hasFileParallelismArgument(`${integrationScript} --file-parallelism=true`)).toBe(true);
    // This lane deliberately owns its forks pool in the imported config; a CLI
    // pool override could silently replace the effective isolation contract.
    expect(hasPoolArgument(integrationScript)).toBe(false);
    expect(hasPoolArgument(`${integrationScript} --pool=threads`)).toBe(true);
    expect(hasPoolArgument(`${integrationScript} --pool threads`)).toBe(true);
    expect(hasPoolArgument(`${integrationScript} "--pool=threads"`)).toBe(true);
    // hasExactArgument must not degrade to substring matching: a lengthened
    // flag name must not satisfy the --no-file-parallelism requirement.
    expect(
      hasExactArgument(
        integrationScript.replace('--no-file-parallelism', '--no-file-parallelismx'),
        '--no-file-parallelism'
      )
    ).toBe(false);
  });
});
