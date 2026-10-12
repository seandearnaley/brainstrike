import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runNativeCoverage } from '../run-native-coverage.mjs';

test('collects an emitted child and worker, remaps source, retains uncovered code and failed exit', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-coverage-')));
  try {
    for (const name of ['src', 'dist']) {
      mkdirSync(path.join(dir, name));
    }
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const source = `export function selected(flag: boolean): string {\n if(flag) return 'yes';\n return 'no';\n}\nexport function untouched(): string { return 'unvisited'; }\n`;
    const filename = path.join(dir, 'src', 'logic.ts');
    writeFileSync(filename, source);
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        sourceMap: true,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: 'logic.ts',
    });
    const map = JSON.parse(emitted.sourceMapText);
    map.sources = ['../src/logic.ts'];
    writeFileSync(path.join(dir, 'dist', 'logic.js'), emitted.outputText);
    writeFileSync(path.join(dir, 'dist', 'logic.js.map'), JSON.stringify(map));
    // Bundled dependencies and executed fixture helpers are outside this owner.
    writeFileSync(path.join(dir, 'vendor.ts'), source);
    writeFileSync(path.join(dir, 'dist', 'vendor.js'), emitted.outputText);
    writeFileSync(
      path.join(dir, 'dist', 'vendor.js.map'),
      JSON.stringify({ ...map, sources: ['../vendor.ts'] })
    );
    mkdirSync(path.join(dir, 'src', '__tests__'));
    writeFileSync(path.join(dir, 'src', '__tests__', 'fixture.mjs'), 'export const fixture = 1;');
    writeFileSync(
      path.join(dir, 'worker.mjs'),
      `import { selected } from './dist/logic.js'; if(selected(false)!=='no') throw new Error('wrong worker result');`
    );
    writeFileSync(
      path.join(dir, 'child.mjs'),
      `import './dist/vendor.js'; import './src/__tests__/fixture.mjs'; import { selected } from './dist/logic.js'; if(selected(true)!=='yes') throw new Error('wrong child result');`
    );
    writeFileSync(
      path.join(dir, 'driver.mjs'),
      `import { Worker } from 'node:worker_threads'; import { spawnSync } from 'node:child_process'; const child=spawnSync(process.execPath,['child.mjs'],{stdio:'inherit'}); if(child.status!==0) throw new Error('child failed'); const worker=new Worker(new URL('./worker.mjs',import.meta.url)); await new Promise((resolve,reject)=>{ worker.on('error',reject); worker.on('exit',resolve); }); process.exitCode=7;`
    );
    assert.equal(await runNativeCoverage(['driver.mjs'], dir), 7);
    const report = JSON.parse(
      readFileSync(path.join(dir, 'coverage/native/coverage-final.json'), 'utf8')
    );
    assert.deepEqual(Object.keys(report), [filename]);
    const entry = report[filename];
    const hits = Object.fromEntries(
      Object.entries(entry.fnMap).map(([id, fn]) => [fn.name, entry.f[id]])
    );
    assert.equal(hits.selected, 2);
    assert.equal(hits.untouched, 0);
    assert.ok(
      Object.values(entry.b)
        .flat()
        .every((hit) => hit > 0)
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('refuses a successful command with no owned native execution', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-coverage-empty-'));
  try {
    await assert.rejects(
      runNativeCoverage(['-e', 'process.exitCode = 0'], dir),
      /no owned source files/
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('leaves Vitest transformed-module coverage to Vitest while collecting its native Worker', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-vitest-coverage-')));
  try {
    mkdirSync(path.join(dir, 'src'));
    const root = fileURLToPath(new URL('../..', import.meta.url));
    symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const source = path.join(dir, 'src', 'logic.mjs');
    writeFileSync(
      source,
      "export function selected(flag) { if(flag) return 'yes'; return 'no'; }\nexport function untouched() { return 'unvisited'; }\n"
    );
    writeFileSync(
      path.join(dir, 'worker.mjs'),
      "import { selected } from './src/logic.mjs'; if(selected(false)!=='no') throw new Error('wrong native result');"
    );
    writeFileSync(
      path.join(dir, 'logic.test.mjs'),
      `import { Worker } from 'node:worker_threads'; import { test, expect } from 'vitest'; import { selected } from './src/logic.mjs'; test('real native boundary', async()=>{ expect(selected(true)).toBe('yes'); const worker=new Worker(new URL('./worker.mjs',import.meta.url)); await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',resolve);}); });`
    );
    writeFileSync(
      path.join(dir, 'vitest.config.mjs'),
      `export default { test: { include: ['logic.test.mjs'], maxWorkers: 1, coverage: { include: ['src/*.mjs'], reporter: ['json'] } } };`
    );
    assert.equal(
      await runNativeCoverage(
        [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage'],
        dir
      ),
      0
    );
    const native = JSON.parse(
      readFileSync(path.join(dir, 'coverage/native/coverage-final.json'), 'utf8')
    )[source];
    const transformed = JSON.parse(
      readFileSync(path.join(dir, 'coverage/coverage-final.json'), 'utf8')
    )[source];
    const functionHits = (entry, name) =>
      Object.entries(entry.fnMap)
        .filter(([, fn]) => fn.name === name)
        .map(([id]) => entry.f[id]);
    assert.deepEqual(functionHits(native, 'selected'), [1]);
    assert.deepEqual(functionHits(transformed, 'selected'), [1]);
    assert.deepEqual(functionHits(native, 'untouched'), [0]);
    assert.ok(Object.values(native.b).flat().includes(0));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('flushes IPC child coverage before its parent forcibly closes the reader', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-ipc-coverage-')));
  try {
    mkdirSync(path.join(dir, 'src'));
    const source = path.join(dir, 'src', 'logic.mjs');
    writeFileSync(
      source,
      'export function selected() { return 23; }\nexport function untouched() { return 0; }\n'
    );
    writeFileSync(
      path.join(dir, 'child.mjs'),
      "import {selected} from './src/logic.mjs'; process.send(selected()); setInterval(()=>{},1000);"
    );
    const preload = fileURLToPath(new URL('../native-ipc-coverage.cjs', import.meta.url));
    writeFileSync(
      path.join(dir, 'driver.mjs'),
      `import {fork} from 'node:child_process'; import assert from 'node:assert/strict'; const child=fork('child.mjs',[],{env:{...process.env,BRAINSTRIKE_NATIVE_COVERAGE_ENTRY:${JSON.stringify(path.join(dir, 'child.mjs'))}},execArgv:['--require',${JSON.stringify(preload)}]}); child.once('message',message=>{assert.equal(message,23);child.kill('SIGKILL');}); await new Promise(resolve=>child.once('close',resolve));`
    );
    assert.equal(await runNativeCoverage(['driver.mjs'], dir), 0);
    const report = JSON.parse(
      readFileSync(path.join(dir, 'coverage/native/coverage-final.json'), 'utf8')
    )[source];
    const hits = Object.fromEntries(
      Object.entries(report.fnMap).map(([id, fn]) => [fn.name, report.f[id]])
    );
    assert.equal(hits.selected, 1);
    assert.equal(hits.untouched, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
