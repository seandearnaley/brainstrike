/**
 * The standalone CLI's Python (owner decision, 2026-11-01): the system Python 3
 * on PATH, asked of each candidate in order once per host, and a visible,
 * actionable refusal when there is none. The POSIX cases put shims on a
 * private PATH.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { processStartTime } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { disposeHostTools } from '../src/command-sessions/host-tool-process.js';
import { createSystemPythonResolver } from '../src/native-tools/system-python.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

/** Where the host's original PATH finds `name`. */
function onPath(name: string): string | undefined {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .map((entry) => join(entry, name))
    .find((file) => existsSync(file));
}

/**
 * A PATH holding only these POSIX shell shims, plus the process listers
 * tree-kill walks a probe's tree with.
 */
async function pathWith(shims: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bs-system-python-'));
  directories.push(directory);
  for (const tool of ['ps', 'pgrep']) {
    const file = onPath(tool);
    if (file) {
      await symlink(file, join(directory, tool));
    }
  }
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

/** A python3 that hangs at startup and records its pid; it never answers. */
function hangingPython(directory: string): string {
  return `echo $$ > '${join(directory, 'probe.pid')}'\nexec /bin/sleep 600`;
}

/** The pid of the hanging probe, once it has started. */
async function probePid(directory: string): Promise<number> {
  const read = () => readFile(join(directory, 'probe.pid'), 'utf8').catch(() => '');
  await expect.poll(read).not.toBe('');
  return Number((await read()).trim());
}

test.skipIf(process.platform === 'win32')(
  'a probe that hangs runs while a call waits, ends when the last call stops, and the next call starts afresh',
  async () => {
    const directory = await pathWith({});
    await writeFile(join(directory, 'python3'), `#!/bin/sh\n${hangingPython(directory)}\n`);
    await chmod(join(directory, 'python3'), 0o755);
    const resolve = createSystemPythonResolver();
    const first = new AbortController();
    const second = new AbortController();
    const firstCall = resolve(first.signal);
    const secondCall = resolve(second.signal);
    const pid = await probePid(directory);
    first.abort(new Error('first stopped'));
    await expect(firstCall).rejects.toThrow('first stopped');
    // Another call still waits on the shared probe, so it keeps running.
    expect(processStartTime(pid)).not.toBeNull();
    second.abort(new Error('second stopped'));
    await expect(secondCall).rejects.toThrow('second stopped');
    await expect.poll(() => processStartTime(pid)).toBeNull();
    // The next call does not wait on the ended probe: it asks the fixed Python.
    await writeFile(join(directory, 'python3'), '#!/bin/sh\nprintf /usr/bin/python3\n');
    await expect(resolve()).resolves.toBe('/usr/bin/python3');
  }
);

test.skipIf(process.platform === 'win32')(
  'host close ends a probe in flight and starts no other candidate',
  async () => {
    const directory = await pathWith({});
    await writeFile(join(directory, 'python3'), `#!/bin/sh\n${hangingPython(directory)}\n`);
    await writeFile(
      join(directory, 'python'),
      `#!/bin/sh\n: > '${join(directory, 'python-started')}'\nprintf /usr/bin/python\n`
    );
    await chmod(join(directory, 'python3'), 0o755);
    await chmod(join(directory, 'python'), 0o755);
    // Held as settled so the refusal arriving during close is observed, not unhandled.
    const call = createSystemPythonResolver()().then(
      () => undefined,
      (error: unknown) => error
    );
    const pid = await probePid(directory);
    await disposeHostTools();
    expect(await call).toMatchObject({
      message: 'The host closed while it was looking for Python.',
    });
    expect(processStartTime(pid)).toBeNull();
    await expect(readFile(join(directory, 'python-started'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
);
