import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Explicit recording from the real production bin: a launch root's project
// hooks file has no trust, so the run commits `hooks.skipped` and the offline
// fixture's question is asked; the committed log is replayed through
// `threads show`. The offline HTTP fixture never reaches a provider.
const run = promisify(execFile);
const bin = fileURLToPath(new URL('../../bin/brainstrike.mjs', import.meta.url));
const http = new URL('./standalone-production-http.mjs', import.meta.url).href;
const output = new URL(
  '../../../test-utils/fixtures/committed-host-hooks-skipped.json',
  import.meta.url
);
const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-record-skip-'));
const home = await mkdtemp(join(tmpdir(), 'bs-m3-record-skip-home-'));
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-record-skip-ws-')));
const env = {
  BRAINSTRIKE_M3_STANDALONE_HTTP: 'question',
  BRAINSTRIKE_M3_STANDALONE_RECEIPT: join(dataRoot, 'offline-receipt.jsonl'),
  BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture',
  HOME: home,
  LC_ALL: 'C',
  NODE_OPTIONS: `--import=${http}`,
  PATH: process.env.PATH,
  TZ: 'UTC',
  USERPROFILE: home,
};
const brainstrike = (args) =>
  run(process.execPath, [bin, '--data-root', dataRoot, ...args], { cwd: tmpdir(), env });
try {
  await mkdir(join(home, '.brainstrike'));
  await mkdir(join(workspace, '.brainstrike'));
  await writeFile(
    join(workspace, '.brainstrike', 'hooks.json'),
    JSON.stringify({
      PreToolUse: [
        {
          command: `echo '{"decision":"block","reason":"Questions are disabled"}'; exit 2`,
          matcher: { tool_name: 'askUser' },
          type: 'command',
        },
      ],
    })
  );
  await brainstrike(['host', 'start', '--workspace', workspace]);
  // Untrusted, the question is asked, and a non-interactive run exits 2.
  const started = await brainstrike([
    'run',
    'Use the recorded canonical human interaction.',
    '--model',
    'openai::gpt-6-sol',
    '--json',
    '--non-interactive',
  ]).catch((error) => {
    if (error.code !== 2) {
      throw error;
    }
    return error;
  });
  const { threadId } = JSON.parse(started.stdout.split('\n')[0] ?? '');
  const shown = await brainstrike(['threads', 'show', '--thread', threadId]);
  const { rows } = JSON.parse(shown.stdout);
  await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`Recorded ${rows.length} committed rows\n`);
} finally {
  await brainstrike(['host', 'stop']);
  await rm(dataRoot, { force: true, recursive: true });
  await rm(home, { force: true, recursive: true });
  await rm(workspace, { force: true, recursive: true });
}
