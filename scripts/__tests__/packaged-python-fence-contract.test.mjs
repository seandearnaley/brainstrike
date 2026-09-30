import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(
  readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')
);
const probe = readFileSync(
  new URL(
    '../../apps/desktop/src/__tests__/fixtures/packaged-python-fence-probe.cjs',
    import.meta.url
  ),
  'utf8'
);

test('manual packaged qualification commands retain distinct layout and full-fence modes', () => {
  assert(pkg.scripts['test:packaged-python-layout'].endsWith('--layout-only'));
  assert(!pkg.scripts['test:packaged-python'].includes('--layout-only'));
  for (const name of ['test:packaged-python-layout', 'test:packaged-python']) {
    assert(pkg.scripts[name].includes('ELECTRON_RUN_AS_NODE=1'));
    assert(pkg.scripts[name].includes('./release/linux-unpacked/brainstrike-desktop'));
    assert(!pkg.scripts[name].includes('--no-sandbox'));
  }
});

test('the retained real probe verifies physical layout and distinct filesystem/seccomp controls', () => {
  assert(probe.includes("require('original-fs')"));
  assert(probe.includes("packedRequire('@brainstrike/agent/fence-executor')"));
  assert(probe.includes('originalFs.statSync(helper).isFile()'));
  assert(probe.includes("spawnSync('/usr/bin/test', ['-x', helper])"));
  for (const marker of [
    'CONTROL_OK',
    'UNIX_SOCKET_DENIED',
    'OUTSIDE_WRITE_DENIED',
    'PACKAGED_PYTHON_FENCE_OK',
    'sandbox_dependencies_missing',
  ]) {
    assert(probe.includes(marker));
  }
  assert(probe.includes("fenceExecution: 'not-run'"));
});
