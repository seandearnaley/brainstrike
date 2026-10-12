// Vitest's inspector measures its workers, not the native processes they own.
// Collect Node's native V8 output as well, using the exact converter/merger
// installed by our pinned Vitest coverage provider (M4 missing child coverage).
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAstAsync } from 'vitest/node';

const providerRequire = createRequire(import.meta.resolve('@vitest/coverage-v8'));
const { convert } = await import(pathToFileURL(providerRequire.resolve('ast-v8-to-istanbul')).href);
const { mergeProcessCovs } = providerRequire('@bcoe/v8-coverage');
const { createCoverageMap } = providerRequire('@vitest/istanbul-lib-coverage');

function ownedSource(filename, cwd) {
  return (
    filename.startsWith(`${path.join(cwd, 'src')}${path.sep}`) &&
    !/(?:^|[/\\])(?:__tests__|fixtures)(?:[/\\])|\.(?:test|spec)\./u.test(filename)
  );
}

function ownedScript(url, cwd) {
  if (!url.startsWith('file:')) {
    return false;
  }
  const filename = fileURLToPath(url);
  return (
    filename.startsWith(`${path.join(cwd, 'dist')}${path.sep}`) ||
    (ownedSource(filename, cwd) && filename.endsWith('.mjs'))
  );
}

export async function collectNativeCoverage(packageDirectory, rawDirectory) {
  const cwd = realpathSync(packageDirectory);
  const reports = readdirSync(rawDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const report = JSON.parse(readFileSync(path.join(rawDirectory, name), 'utf8'));
      // Vitest owns transformed modules in its own runner. Their V8 offsets
      // describe transformed code, not the on-disk source used below. Native
      // children/Workers do not load the runner (the inherited warnings preload
      // is harmless and deliberately does not match this condition).
      const vitestRunner = report.result.some((script) =>
        /\/(?:vitest\/(?:vitest\.mjs|dist\/)|@vitest\/runner\/)/u.test(script.url)
      );
      return {
        result: vitestRunner ? [] : report.result.filter((script) => ownedScript(script.url, cwd)),
      };
    });
  const coverage = createCoverageMap({});
  for (const script of mergeProcessCovs(reports).result) {
    const filename = fileURLToPath(script.url);
    const code = readFileSync(filename, 'utf8');
    const mapPath = `${filename}.map`;
    let sourceMap;
    if (existsSync(mapPath)) {
      sourceMap = JSON.parse(readFileSync(mapPath, 'utf8'));
      sourceMap.sources = sourceMap.sources.map((source) =>
        path.resolve(path.dirname(mapPath), sourceMap.sourceRoot ?? '', source)
      );
      sourceMap.sourceRoot = '';
      sourceMap.sourcesContent = sourceMap.sources.map((source) => readFileSync(source, 'utf8'));
    } else if (filename.startsWith(`${path.join(cwd, 'dist')}${path.sep}`)) {
      throw new Error(`Native coverage needs the emitted source map: ${mapPath}`);
    }
    const converted = await convert({
      ast: await parseAstAsync(code),
      code,
      coverage: script,
      sourceMap,
      wrapperLength: 0,
    });
    for (const [source, entry] of Object.entries(converted)) {
      // Bundled entries also map vendor and workspace dependency code. Their
      // owners collect those sources; this report has the package's source scope.
      if (!ownedSource(source, cwd)) {
        continue;
      }
      coverage.addFileCoverage(entry);
    }
  }
  return coverage.toJSON();
}

export async function runNativeCoverage(args, cwd = process.cwd()) {
  if (args.length === 0) {
    throw new Error('Native coverage requires a Node entry point and arguments.');
  }
  const temporary = path.join(cwd, '.nyc_output');
  mkdirSync(temporary, { recursive: true });
  const rawDirectory = mkdtempSync(path.join(temporary, 'native-'));
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, NODE_V8_COVERAGE: rawDirectory },
    stdio: 'inherit',
  });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Native coverage command exited with ${signal}`));
      } else {
        resolve(code ?? 1);
      }
    });
  });
  const coverage = await collectNativeCoverage(cwd, rawDirectory);
  if (status === 0 && Object.keys(coverage).length === 0) {
    throw new Error(`Native coverage collected no owned source files; raw data ${rawDirectory}`);
  }
  const output = path.join(cwd, 'coverage', 'native');
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'coverage-final.json'), JSON.stringify(coverage));
  console.log(
    `Native coverage: ${Object.keys(coverage).length} source files; raw data ${rawDirectory}`
  );
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runNativeCoverage(process.argv.slice(2));
}
