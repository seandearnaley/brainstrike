import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeHostSpawner } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';

// BST-1977: retained physical startup-owner regression, authorized causal repair.
test('ordinary failed startup retains its process and lease while a real root-writing descendant cannot join', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-startup-owner-'));
  const initial = await StateStore.open(root);
  await initial.append([
    { event: { commandId: randomUUID(), type: 'thread.started' }, threadId: randomUUID() },
  ]);
  await initial.close();
  const modulePath = join(root, 'platform.mjs');
  const childProgram =
    "const fs=require('node:fs');const path=process.argv[1];fs.appendFileSync(path,'owned\\n');process.send({ready:true});setInterval(()=>fs.appendFileSync(path,'owned\\n'),50);";
  await writeFile(
    modulePath,
    `import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function createHostPlatform(options) {
  const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)},join(options.root,'root-writing-child')],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
  await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject)});
  await writeFile(join(options.root,'owned-child-pid'),String(child.pid));
  child.disconnect();child.unref();
  return {attachMcpTaskOwner:()=>{throw new Error('MCP task owner refused')},close:async()=>{throw new Error('physical child cleanup rejected')},maxSteps:3,tools:{},readPermissionPolicy:()=>({policies:{},yolo:false}),resolveModel:async()=>{throw new Error('startup never invokes a model')}};
}
`
  );
  let childPid: number | undefined;
  let childStart: string | null | undefined;
  let ownerPid: number | undefined;
  let ownerStart: string | undefined;
  try {
    const spawnHost = createNodeHostSpawner({
      entryArgs: [modulePath],
      entrypoint: fileURLToPath(new URL('../dist/process-entry.js', import.meta.url)),
      output: 'ignore',
    });
    await expect(
      spawnHost({ lifetime: 'persistent', root }, new AbortController().signal)
    ).rejects.toThrow('cleanup failed');
    childPid = Number(await readFile(join(root, 'owned-child-pid'), 'utf8'));
    childStart = processStartTime(childPid);
    const owner = RootLock.inspect(root)?.owner;
    if (!owner) {
      throw new Error('Expected acquired startup owner');
    }
    ownerPid = owner.pid;
    ownerStart = owner.start;
    let secondOwnerAcquired = false;
    try {
      const second = await StateStore.open(root);
      secondOwnerAcquired = true;
      await second.close();
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === 'RootLockedError')) {
        throw cause;
      }
    }
    const evidence = {
      childPid,
      childStart,
      descendantStillAlive: childStart !== null,
      ownerPid,
      ownerStart,
      ownerStillAlive: processStartTime(ownerPid) === ownerStart,
      secondOwnerAcquired,
    };
    await writeFile(
      '/tmp/brainstrike-m3-review-startup-ownership-repro.json',
      JSON.stringify(evidence, null, 2)
    );
    expect(evidence.ownerStillAlive).toBe(true);
    expect(evidence.secondOwnerAcquired).toBe(false);
  } finally {
    if (childPid && childStart && processStartTime(childPid) === childStart) {
      process.kill(childPid, 'SIGTERM');
      await expect.poll(() => processStartTime(childPid ?? 0)).not.toBe(childStart);
    }
    if (ownerPid && ownerStart && processStartTime(ownerPid) === ownerStart) {
      // Fixture teardown only: the descendant has already physically exited.
      process.kill(ownerPid, 'SIGKILL');
      await expect.poll(() => processStartTime(ownerPid ?? 0)).not.toBe(ownerStart);
    }
    await rm(root, { force: true, recursive: true });
  }
});
