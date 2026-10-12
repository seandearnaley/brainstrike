import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);

test('loads legacy native tools without loading the agent host kernel', async () => {
  // M3's native-tools import pulled HostCore into Main before the utility could
  // start. Observe actual parsed runtime modules, rather than source text.
  const home = await mkdtemp(join(tmpdir(), 'native-tools-load-'));
  try {
    const { stdout } = await execute(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { Session } from 'node:inspector';
const session = new Session();
const loaded = [];
session.connect();
session.on('Debugger.scriptParsed', ({ params }) => loaded.push(params.url));
await new Promise((resolve, reject) => session.post('Debugger.enable', error => error ? reject(error) : resolve()));
const native = await import('@brainstrike/host-capabilities/native-tools');
const registry = new native.ReadWorkspaceFileCursorRegistry();
const cleared = registry.clear() === undefined;
const kernelModules = loaded.filter(url => url.endsWith('/agent-host/dist/core.js'));
session.disconnect();
process.stdout.write(JSON.stringify({ cleared, kernelModules }));`,
      ],
      {
        cwd: join(import.meta.dirname, '..'),
        env: { HOME: home, MASTRA_TELEMETRY_DISABLED: 'true', NODE_ENV: 'test' },
      }
    );
    expect(JSON.parse(stdout)).toEqual({ cleared: true, kernelModules: [] });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
