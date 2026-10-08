import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Explicit recording from the real production bin: a global PreToolUse hook
// blocks the offline fixture's question tool, and the committed log is replayed
// through `threads show`. The offline HTTP fixture never reaches a provider.
const run = promisify(execFile);
const bin = fileURLToPath(new URL('../../bin/brainstrike.mjs', import.meta.url));
const http = new URL('./standalone-production-http.mjs', import.meta.url).href;
const output = new URL(
  '../../../test-utils/fixtures/committed-host-hook-blocked.json',
  import.meta.url
);
const reason = 'Questions are disabled in this workspace';
const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-record-hook-'));
const home = await mkdtemp(join(tmpdir(), 'bs-m3-record-hook-home-'));
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
  await writeFile(
    join(home, '.brainstrike', 'hooks.json'),
    JSON.stringify({
      PreToolUse: [
        {
          command: `echo '{"decision":"block","reason":"${reason}"}'; exit 2`,
          matcher: { tool_name: 'askUser' },
          type: 'command',
        },
      ],
    })
  );
  await brainstrike(['host', 'start']);
  const started = await brainstrike([
    'run',
    'Use the recorded canonical human interaction.',
    '--model',
    'openai::gpt-6-sol',
    '--json',
    '--non-interactive',
  ]);
  const { threadId } = JSON.parse(started.stdout.split('\n')[0] ?? '');
  const shown = await brainstrike(['threads', 'show', '--thread', threadId]);
  const { rows } = JSON.parse(shown.stdout);
  await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`Recorded ${rows.length} committed rows\n`);
} finally {
  await brainstrike(['host', 'stop']);
  await rm(dataRoot, { force: true, recursive: true });
  await rm(home, { force: true, recursive: true });
}
