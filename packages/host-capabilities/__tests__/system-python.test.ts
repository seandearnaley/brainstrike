/**
 * The standalone CLI's Python (owner decision, 2026-11-01): the system Python 3
 * on PATH, asked of each candidate in order once per host, and a visible,
 * actionable refusal when there is none. The POSIX cases put shims on a
 * private PATH.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createSystemPythonResolver } from '../src/native-tools/system-python.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

/** A PATH holding only these POSIX shell shims. */
async function pathWith(shims: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bs-system-python-'));
  directories.push(directory);
  for (const [name, body] of Object.entries(shims)) {
    await writeFile(join(directory, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(directory, name), 0o755);
  }
  vi.stubEnv('PATH', directory);
  return directory;
}

test('no Python on PATH is a refusal that names what was tried and how to fix it', async () => {
  await pathWith({});
  const refusal = createSystemPythonResolver()();
  await expect(refusal).rejects.toMatchObject({ code: 'python_not_found' });
  await expect(refusal).rejects.toThrow(
    process.platform === 'win32'
      ? /tried py -3 \(not found\), python \(not found\)\. Install Python 3 from python\.org/u
      : /tried python3 \(not found\), python \(not found\)\. Install Python 3 so `python3` is on/u
  );
});

test.skipIf(process.platform === 'win32')(
  'runs the interpreter python3 names, as Python itself reports it',
  async () => {
    await pathWith({ python: 'exit 1', python3: 'printf /opt/python/bin/python3.13' });
    await expect(createSystemPythonResolver()()).resolves.toBe('/opt/python/bin/python3.13');
  }
);

test.skipIf(process.platform === 'win32')(
  'skips a python3 that is not Python 3 and reports each candidate when none is',
  async () => {
    await pathWith({ python: 'echo "Unknown option: -I" >&2; exit 2', python3: 'exit 3' });
    await expect(createSystemPythonResolver()()).rejects.toThrow(
      'tried python3 (not Python 3), python (Unknown option: -I)'
    );
  }
);

test.skipIf(process.platform === 'win32')(
  'falls through to python when python3 is absent',
  async () => {
    await pathWith({ python: 'printf /usr/bin/python3' });
    await expect(createSystemPythonResolver()()).resolves.toBe('/usr/bin/python3');
  }
);

test('a stopped call stops resolving', async () => {
  await pathWith({});
  const stopped = new AbortController();
  stopped.abort(new Error('stopped'));
  await expect(createSystemPythonResolver()(stopped.signal)).rejects.toThrow('stopped');
});

test.skipIf(process.platform === 'win32')(
  'asks Python once per host, and asks again only after a refusal',
  async () => {
    const directory = await pathWith({});
    const resolve = createSystemPythonResolver();
    await expect(resolve()).rejects.toMatchObject({ code: 'python_not_found' });
    // Python installed after the refusal is found by the next call.
    const probes = join(directory, 'probes.log');
    await writeFile(
      join(directory, 'python3'),
      `#!/bin/sh\necho probe >> '${probes}'\nprintf /usr/bin/python3\n`
    );
    await chmod(join(directory, 'python3'), 0o755);
    const calls = await Promise.all([resolve(), resolve(), resolve()]);
    await expect(resolve()).resolves.toBe('/usr/bin/python3');
    expect(calls).toEqual(['/usr/bin/python3', '/usr/bin/python3', '/usr/bin/python3']);
    expect((await readFile(probes, 'utf8')).trim().split('\n')).toEqual(['probe']);
  }
);
