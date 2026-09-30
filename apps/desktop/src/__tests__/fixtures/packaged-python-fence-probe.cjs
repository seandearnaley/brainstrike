'use strict';
// Runs only under the actual packaged Electron in supported Node mode.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const originalFs = require('original-fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');

async function qualify(resources, state, layoutOnly) {
  assert(path.isAbsolute(resources) && path.isAbsolute(state));
  const packedRequire = createRequire(path.join(resources, 'app.asar/package.json'));
  const entry = packedRequire.resolve('@brainstrike/agent/fence-executor');
  assert(entry.startsWith(path.join(resources, 'app.asar') + path.sep));
  const { createFenceExecutor } = packedRequire('@brainstrike/agent/fence-executor');
  const helper = path.join(
    resources,
    'app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp',
    process.arch,
    'apply-seccomp'
  );
  assert(originalFs.statSync(helper).isFile(), 'helper must be a physical file');
  assert.equal(
    spawnSync('/usr/bin/test', ['-x', helper]).status,
    0,
    'helper must be executable by the OS'
  );
  const runtimeResources = path.join(resources, 'python-runtime');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runtimeResources, 'manifest.json'), 'utf8')
  );
  const derived = manifest.targets['x86_64-unknown-linux-gnu'].derived;
  const archive = fs.readFileSync(path.join(runtimeResources, derived.archiveFileName));
  assert.equal(archive.length, derived.bytes);
  assert.equal(createHash('sha256').update(archive).digest('hex'), derived.sha256);
  if (layoutOnly) {
    console.log(
      JSON.stringify({
        derived,
        entry,
        fenceExecution: 'not-run',
        helper,
        phase: 'packaged-layout-verified',
      })
    );
    return;
  }
  for (const name of ['install', 'scratch', 'outside']) {
    fs.mkdirSync(path.join(state, name), { recursive: true });
  }
  const unpack = spawnSync(
    '/usr/bin/tar',
    [
      '--use-compress-program=/usr/bin/gzip',
      '-xf',
      path.join(runtimeResources, derived.archiveFileName),
      '-C',
      path.join(state, 'install'),
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.equal(unpack.status, 0, unpack.stderr);
  const binary = path.join(state, 'install/python/bin/python3');
  const socketControl = spawnSync(
    binary,
    [
      '-I',
      '-c',
      'import socket; socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).close(); print("CONTROL_OK")',
    ],
    { encoding: 'utf8', env: { PATH: '/nonexistent' }, timeout: 10_000 }
  );
  assert.equal(socketControl.status, 0, socketControl.stderr);
  assert(socketControl.stdout.includes('CONTROL_OK'));
  const outside = path.join(state, 'outside/must-not-exist');
  fs.writeFileSync(outside, 'writable host control');
  fs.unlinkSync(outside);
  console.log(
    JSON.stringify({
      derived,
      entry,
      helper,
      helperSha256: createHash('sha256').update(originalFs.readFileSync(helper)).digest('hex'),
      phase: 'physical-helper-verified',
      socketControl: true,
    })
  );
  const executor = await createFenceExecutor({
    interpreters: { python: { args: ['-I'], command: binary, scriptExtension: 'py' } },
    linuxSeccompApplyPath: helper,
  });
  try {
    const code = [
      'import sys, socket, ssl, sqlite3, dbm, dbm.sqlite3, shelve',
      'assert sys.version_info[:3] == (3, 13, 14)',
      `assert sys.executable == ${JSON.stringify(binary)}`,
      'try:',
      '    import _dbm',
      'except ModuleNotFoundError:',
      '    pass',
      'else:',
      '    raise AssertionError("_dbm unexpectedly shipped")',
      'with dbm.open("store", "c") as d:',
      '    d[b"key"] = b"value"',
      '    assert d[b"key"] == b"value"',
      'with dbm.sqlite3.open("sqlite-store", "c") as d:',
      '    d[b"key"] = b"value"',
      '    assert d[b"key"] == b"value"',
      'with shelve.open("shelf") as d:',
      '    d["key"] = [1, 2, 3]',
      '    assert d["key"] == [1, 2, 3]',
      'try:',
      `    open(${JSON.stringify(outside)}, "w").write("escape")`,
      'except OSError as e:',
      '    print("OUTSIDE_WRITE_DENIED", type(e).__name__, e.errno)',
      'else:',
      '    raise AssertionError("outside write escaped")',
      'try:',
      '    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
      'except OSError as e:',
      '    print("UNIX_SOCKET_DENIED", type(e).__name__, e.errno)',
      'else:',
      '    sock.close()',
      '    raise AssertionError("AF_UNIX creation escaped seccomp")',
      'print("PACKAGED_PYTHON_FENCE_OK")',
    ].join('\n');
    const result = await executor.execute({
      code,
      language: 'python',
      maxOutputBytes: 65_536,
      policy: { allowedDomains: [], allowWrite: [path.join(state, 'scratch')] },
      scratchDir: path.join(state, 'scratch'),
      signal: new AbortController().signal,
      timeoutMs: 20_000,
    });
    console.log(JSON.stringify({ phase: 'packaged-fence-result', ...result }));
    assert.equal(result.exitCode, 0, result.stderr);
    for (const marker of [
      'PACKAGED_PYTHON_FENCE_OK',
      'OUTSIDE_WRITE_DENIED',
      'UNIX_SOCKET_DENIED',
    ]) {
      assert(result.stdout.includes(marker));
    }
    assert(!originalFs.existsSync(outside));
  } finally {
    await executor.dispose();
  }
  await assert.rejects(
    async () => {
      const unexpected = await createFenceExecutor({
        interpreters: { python: { command: binary, scriptExtension: 'py' } },
        linuxSeccompApplyPath: path.join(state, 'missing-helper'),
      });
      await unexpected.dispose();
      assert.fail('An unavailable explicit helper must never be replaced by a fallback.');
    },
    { reason: 'sandbox_dependencies_missing' }
  );
  console.log(JSON.stringify({ fallback: false, phase: 'missing-helper-refused' }));
}
async function main() {
  const args = process.argv.slice(2);
  const layoutOnly = args[0] === '--layout-only';
  if (layoutOnly) {
    args.shift();
  }
  assert(args.length <= 2, 'expected optional resources and disposable-state paths');
  const [resourcesArg, stateArg] = args;
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  const resources = resourcesArg ?? path.join(path.dirname(process.execPath), 'resources');
  const state = stateArg ?? fs.mkdtempSync(path.join(tmpdir(), 'brainstrike-packaged-python-'));
  assert(path.isAbsolute(resources) && path.isAbsolute(state));
  fs.mkdirSync(path.join(state, 'home'), { recursive: true });
  fs.mkdirSync(path.join(state, 'tmp'), { recursive: true });
  const executablePath = process.env.PATH ?? '/usr/bin:/bin';
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: path.join(state, 'home'),
    LANG: 'C.UTF-8',
    PATH: executablePath,
    TMPDIR: path.join(state, 'tmp'),
  });
  try {
    await qualify(resources, state, layoutOnly);
  } finally {
    if (!stateArg) {
      fs.rmSync(state, { force: true, recursive: true });
    }
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      cause: error.cause instanceof Error ? error.cause.message : undefined,
      code: error.code,
      message: error.message,
      name: error.name,
      phase: 'failure',
      reason: error.reason,
    })
  );
  process.exitCode = 1;
});
