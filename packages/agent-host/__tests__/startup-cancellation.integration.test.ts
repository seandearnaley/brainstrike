import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeHostSpawner } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { startAgentHost } from '../src/runtime.js';

test('cancellation before acquisition constructs no platform and leaves no root owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-before-acquire-'));
  const controller = new AbortController();
  const failure = new Error('Cancelled before acquisition');
  controller.abort(failure);
  let initialized = false;
  try {
    await expect(
      startAgentHost(
        { lifetime: 'persistent', root },
        () => {
          initialized = true;
          throw new Error('Initializer must not run');
        },
        controller.signal
      )
    ).rejects.toBe(failure);
    expect(initialized).toBe(false);
    expect(RootLock.inspect(root)).toBeNull();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test.each(['initializer rejection', 'launcher cancellation', 'missing startup report'] as const)(
  'a registered partial startup child joins before root reuse after %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-partial-startup-'));
    const modulePath = join(root, 'platform.mjs');
    // The same real root-writing descendant shape as the retained failure repro.
    const program =
      "const fs=require('node:fs');const path=process.argv[1];fs.appendFileSync(path,'owned\\n');process.send({ready:true});setInterval(()=>fs.appendFileSync(path,'owned\\n'),50);";
    await writeFile(
      modulePath,
      `import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function createHostPlatform(options, context) {
  let child;
  let exited;
  await context.register(async()=>{
    if(!child) return;
    if(child && child.exitCode===null && child.signalCode===null) child.kill('SIGTERM');
    await exited;
    await writeFile(join(options.root,'joined'),String(child.pid));
  });
  context.signal.throwIfAborted();
  child=spawn(process.execPath,['-e',${JSON.stringify(program)},join(options.root,'root-writing-child')],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
  exited=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)});
  await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject)});
  await writeFile(join(options.root,'child-pid'),String(child.pid));
  if(${JSON.stringify(mode)}==='missing startup report') {
    const send=process.send.bind(process);
    process.send=(message,...args)=>{
      if(message.event==='ready') {
        const callback=args.at(-1);
        if(typeof callback==='function') callback(null);
        return true;
      }
      return send(message,...args);
    };
    return {close:async()=>{},maxSteps:3,tools:{},readPermissionPolicy:()=>({policies:{},yolo:false}),resolveModel:async()=>{throw new Error('No model call at startup')}};
  }
  if(${JSON.stringify(mode)}==='launcher cancellation') {
    await new Promise((resolve,reject)=>{
      context.signal.addEventListener('abort',()=>reject(context.signal.reason),{once:true});
      if(context.signal.aborted) reject(context.signal.reason);
    });
  }
  throw new Error('Recorded partial initializer rejection');
}
`
    );
    let ownerPid: number | undefined;
    let ownerStart: string | undefined;
    let childPid: number | undefined;
    const controller = new AbortController();
    try {
      const spawnHost = createNodeHostSpawner({
        entryArgs: [modulePath],
        entrypoint: fileURLToPath(new URL('../dist/process-entry.js', import.meta.url)),
        output: 'ignore',
      });
      const starting = spawnHost({ lifetime: 'persistent', root }, controller.signal);
      starting.catch(() => undefined);
      if (mode !== 'initializer rejection') {
        await expect
          .poll(async () => {
            try {
              childPid = Number(await readFile(join(root, 'child-pid'), 'utf8'));
              return childPid > 0;
            } catch {
              return false;
            }
          })
          .toBe(true);
        const owner = RootLock.inspect(root)?.owner;
        ownerPid = owner?.pid;
        ownerStart = owner?.start;
        if (mode === 'launcher cancellation') {
          controller.abort(new Error('Recorded launcher cancellation'));
        }
      }
      await expect(starting).rejects.toThrow(
        mode === 'launcher cancellation'
          ? 'Recorded launcher cancellation'
          : mode === 'missing startup report'
            ? 'did not become ready'
            : 'partial initializer rejection'
      );
      childPid = Number(await readFile(join(root, 'child-pid'), 'utf8'));
      await expect
        .poll(async () => {
          try {
            return Number(await readFile(join(root, 'joined'), 'utf8'));
          } catch {
            return 0;
          }
        })
        .toBe(childPid);
      await expect.poll(() => processStartTime(childPid ?? 0)).toBeNull();
      await expect.poll(() => RootLock.inspect(root)?.owner.released).toBe(true);
      if (ownerPid) {
        await expect.poll(() => processStartTime(ownerPid ?? 0)).not.toBe(ownerStart);
      }
      const reopened = await StateStore.open(root);
      await reopened.append([{ event: { type: 'thread.started' }, threadId: randomUUID() }]);
      await reopened.close();
      await writeFile(
        `/tmp/brainstrike-m3-partial-startup-${mode.replaceAll(' ', '-')}.json`,
        JSON.stringify(
          { childJoined: true, childPid, ownerPid, ownerStart, rootReusedAfterJoin: true },
          null,
          2
        )
      );
    } finally {
      controller.abort(new Error('Fixture teardown'));
      // Only fixture-owned descendants/owners are touched, after causal assertions.
      if (childPid && processStartTime(childPid) !== null) {
        process.kill(childPid, 'SIGTERM');
        await expect.poll(() => processStartTime(childPid ?? 0)).toBeNull();
      }
      if (ownerPid && ownerStart && processStartTime(ownerPid) === ownerStart) {
        process.kill(ownerPid, 'SIGKILL');
        await expect.poll(() => processStartTime(ownerPid ?? 0)).not.toBe(ownerStart);
      }
      await rm(root, { force: true, recursive: true });
    }
  }
);
