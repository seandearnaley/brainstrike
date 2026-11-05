// The process the approval crash sweep kills (ADR-0010: an answered approval runs at most once).
// It runs one approval round trip: start a run, wait for the approval, approve it, let the tool
// append its line, wait for the run to finish. Every run-log commit of its store is counted
// through the store's own `onWriteSpan` observer, which fires once the COMMIT has returned and
// before the appending caller sees it. At commit `killAt` the process SIGKILLs itself, so the
// sweep stops it exactly after that commit and nowhere else. `killAt` 0 dies before the first
// command; `KILL_INSIDE_EFFECT` dies inside the tool, after its line is written; any other
// negative `killAt` never dies and prints the total as `COMMITS <n>`.
// usage: node approval-crash-host.ts <dataRoot> <effectFile> <killAt>
import '@brainstrike/secure-fs-native/default-owner';
import { StateStore } from '@brainstrike/state-store';
import { HostCore } from '../../src/core.ts';
import type { HostEvent, HostLogRow } from '../../src/protocol.ts';
import { approvalCrashPlatform, KILL_INSIDE_EFFECT } from './approval-crash-platform.ts';

const [root, effectFile, killAtArgument] = process.argv.slice(2) as [string, string, string];
const killAt = Number(killAtArgument);
let commits = 0;
const store = await StateStore.open(root, {
  onWriteSpan: () => {
    commits += 1;
    if (commits === killAt) {
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
const core = await HostCore.open(
  store,
  approvalCrashPlatform(effectFile, { dieAfterEffect: killAt === KILL_INSIDE_EFFECT }),
  () => () => undefined
);
if (killAt === 0) {
  process.kill(process.pid, 'SIGKILL');
}

function committed<Type extends HostEvent['type']>(
  type: Type
): Promise<Extract<HostEvent, { type: Type }>> {
  return new Promise((resolve) => {
    const stop = core.onCommitted((row: HostLogRow) => {
      if (row.event.type === type) {
        stop();
        resolve(row.event as Extract<HostEvent, { type: Type }>);
      }
    });
  });
}

const requested = committed('interaction.requested');
const finished = committed('run.finished');
const { threadId } = await core.startThread({ commandId: 'crash-sweep-thread' });
const { runId } = await core.startRun({
  commandId: 'crash-sweep-run',
  modelId: 'scripted',
  prompt: 'Append the approved line',
  threadId,
});
const approval = await requested;
await core.respond({
  commandId: 'crash-sweep-answer',
  decision: 'approve',
  interactionId: approval.interactionId,
  runId,
  threadId,
});
const outcome = await finished;
await core.close();
await store.close();
process.stdout.write(`COMMITS ${commits} ${outcome.outcome}\n`);
