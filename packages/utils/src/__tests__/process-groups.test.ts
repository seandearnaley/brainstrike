import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { onProcessGroup, trackChildProcessGroup } from '../process-groups.ts';

// A leader that starts a member of its own group which ignores SIGTERM and holds the leader's
// stdout, then exits.
const LEADER = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6);"], { stdio: ['ignore', 'inherit', 'ignore'] });
process.stdout.write('started\\n', () => process.exit(0));
`;

const groups: number[] = [];

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

describe.skipIf(process.platform === 'win32')('process groups', () => {
  it('reports a group ended only once no member of it is left running', async () => {
    const events: string[] = [];
    const stop = onProcessGroup((event) => events.push(event.state));
    const leader = spawn(process.execPath, ['-e', LEADER], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    groups.push(leader.pid ?? 0);
    trackChildProcessGroup(leader);
    leader.stdout.resume();
    // The member holds the leader's stdout, so it closes only once the member is gone.
    await once(leader.stdout, 'close');
    stop();
    expect(events).toEqual(['started', 'ended']);
  }, 10_000);
});
