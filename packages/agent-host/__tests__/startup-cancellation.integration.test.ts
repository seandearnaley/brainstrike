import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createNodeHostSpawner } from '@brainstrike/host-lease';
import { processStartTime, RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { startAgentHost } from '../src/runtime.js';
import { observeFixtureStartup, removeFixtureRoot } from './fixtures/cooperative-host-fixture.js';
import { recordFixtureEvent } from './fixtures/owned-fixture-process.js';

test('a synchronous platform close failure still joins a registered physical startup child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-sync-close-'));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  let joined = false;
  let initializedStore: StateStore | undefined;
  const failure = new Error('Recorded synchronous platform close');
  const host = await startAgentHost({ lifetime: 'persistent', root }, async (context) => {
    initializedStore = context.store;
    await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
    await context.register(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      await exited;
      joined = true;
    });
    child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');process.stdin.resume()"],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    exited = new Promise<void>((resolve, reject) => {
      child?.once('close', () => resolve());
      child?.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      child?.stdout?.once('data', () => resolve());
      child?.once('error', reject);
    });
    return {
      close: (): Promise<void> => {
        throw failure;
      },
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => {
        throw new Error('No model during startup');
      },
      tools: {},
    };
  });
  try {
    expect(initializedStore).toBe(host.core.store);
    await expect(host.close()).rejects.toThrow();
    expect(joined).toBe(true);
    expect(processStartTime(child?.pid ?? 0)).toBeNull();
    await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    await exited;
    if (host.core.store instanceof StateStore) {
      await host.core.store.close();
    }
    await rm(root, { force: true, recursive: true });
  }
});

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

/** Stands in for the starter's 10 s production readiness deadline (pinned in host-lease). */
const MISSING_REPORT_READY_DEADLINE_MS = 6000;

const startupModes = [
  'initializer rejection',
  'launcher cancellation',
  'missing startup report',
  'early child exit',
  'readiness watchdog abort',
] as const;

test.for(startupModes)(
  'a registered partial startup child joins before root reuse after %s',
  async (mode, context) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-partial-startup-'));
    const modulePath = join(root, 'platform.mjs');
    const controller = new AbortController();
    const watchdog = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal, watchdog.signal]);
    const observer = await observeFixtureStartup(root, signal);
    let starting: Promise<void> | undefined;
    let ownerPid: number | undefined;
    let ownerStart: string | undefined;
    let childPid: number | undefined;
    try {
      // The same real root-writing descendant shape as the retained failure repro.
      const program =
        mode === 'early child exit'
          ? "process.stderr.write('Recorded child exit before readiness');process.exit(23);"
          : `const fs=require('node:fs');const path=process.argv[1];fs.appendFileSync(path,'owned\\n');${mode === 'readiness watchdog abort' ? '' : 'process.send({ready:true});'}setInterval(()=>fs.appendFileSync(path,'owned\\n'),50);`;
      await writeFile(
        modulePath,
        `import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {join} from 'node:path';
export async function createHostPlatform(options, context) {
  let child;
  let exited;
  let stream;
  let streamClosed;
  let stderr='';
  await context.register(async()=>{
    if(child) {
      if(child.exitCode===null && child.signalCode===null) child.kill('SIGTERM');
      await exited;
      await writeFile(join(options.root,'joined'),String(child.pid));
      if(stream?.writable) stream.end(JSON.stringify({event:'joined',pid:child.pid})+'\\n');
    } else stream?.end();
    await streamClosed;
  });
  context.signal.throwIfAborted();
  stream=createConnection(${JSON.stringify(observer.endpoint)});
  streamClosed=new Promise(resolve=>stream.once('close',resolve));
  await once(stream,'connect',{signal:context.signal});
  context.signal.throwIfAborted();
  child=spawn(process.execPath,['-e',${JSON.stringify(program)},join(options.root,'root-writing-child')],{detached:true,stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',value=>{stderr+=value});
  exited=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)});
  exited.catch(()=>{});
  stream.write(JSON.stringify({event:'spawned',pid:child.pid})+'\\n');
  try {
    await new Promise((resolve,reject)=>{
      const cleanup=()=>{
        child.off('message',ready);
        child.off('error',failed);
        child.off('close',closed);
        context.signal.removeEventListener('abort',aborted);
      };
      const failed=cause=>{cleanup();reject(cause)};
      const ready=message=>{
        if(message.ready===true) {cleanup();resolve()}
      };
      const closed=(code,signal)=>failed(new Error('Recorded descendant exited before readiness ('+(code??signal)+'): '+stderr));
      const aborted=()=>failed(context.signal.reason);
      child.once('message',ready);
      child.once('error',failed);
      child.once('close',closed);
      context.signal.addEventListener('abort',aborted,{once:true});
      if(context.signal.aborted) aborted();
    });
  } catch(cause) {
    stream.write(JSON.stringify({event:'failed',message:cause.message})+'\\n');
    throw cause;
  }
  await writeFile(join(options.root,'child-pid'),String(child.pid));
  // Emit only at the original marker stage, after Root/writer acquisition and child IPC readiness.
  await new Promise((resolve,reject)=>{
    let response='';
    const cleanup=()=>{
      stream.off('data',accepted);
      stream.off('error',failed);
      stream.off('close',closed);
      context.signal.removeEventListener('abort',aborted);
    };
    const failed=cause=>{cleanup();reject(cause)};
    const accepted=value=>{
      response+=value.toString();
      if(!response.includes('\\n')) return;
      if(response!=='accepted\\n') failed(new Error('Fixture readiness was not accepted'));
      else {cleanup();resolve()}
    };
    const closed=()=>failed(new Error('Fixture readiness stream closed before acceptance'));
    const aborted=()=>failed(context.signal.reason);
    stream.on('data',accepted);
    stream.once('error',failed);
    stream.once('close',closed);
    context.signal.addEventListener('abort',aborted,{once:true});
    if(context.signal.aborted) {aborted();return}
    stream.write(JSON.stringify({event:'ready',pid:child.pid})+'\\n');
  });
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
      const spawnHost = createNodeHostSpawner({
        entryArgs: [modulePath],
        entrypoint: fileURLToPath(new URL('../dist/process-entry.js', import.meta.url)),
        output: 'ignore',
        // The swallowed report reaches the starter's readiness deadline. A narrowed
        // deadline still expires only after the fixture's own readiness handshake
        // (about 2 s on a loaded host); expiring earlier fails `observer.ready`.
        ...(mode === 'missing startup report'
          ? { readyTimeoutMs: MISSING_REPORT_READY_DEADLINE_MS }
          : {}),
      });
      starting = spawnHost({ lifetime: 'persistent', root }, signal);
      void starting.then(
        () => observer.fail(new Error('Host starter completed without the fixture marker')),
        observer.fail
      );
      childPid = await observer.spawned;
      const owner = RootLock.inspect(root)?.owner;
      ownerPid = owner?.pid;
      ownerStart = owner?.start;
      expect(ownerPid).toBeGreaterThan(0);
      expect(owner?.released).not.toBe(true);
      if (mode === 'readiness watchdog abort') {
        const failure = new Error('Recorded readiness watchdog abort');
        watchdog.abort(failure);
        await expect(observer.ready).rejects.toBe(failure);
      } else if (mode === 'early child exit') {
        await expect(observer.ready).rejects.toThrow('Recorded child exit before readiness');
      } else {
        expect(await observer.ready).toBe(childPid);
        expect(Number(await readFile(join(root, 'child-pid'), 'utf8'))).toBe(childPid);
        if (mode === 'launcher cancellation') {
          controller.abort(new Error('Recorded launcher cancellation'));
        }
      }
      await expect(starting).rejects.toThrow(
        mode === 'launcher cancellation'
          ? 'Recorded launcher cancellation'
          : mode === 'missing startup report'
            ? 'did not become ready'
            : mode === 'early child exit'
              ? 'Recorded child exit before readiness'
              : mode === 'readiness watchdog abort'
                ? 'Recorded readiness watchdog abort'
                : 'partial initializer rejection'
      );
      expect(await observer.joined).toBe(childPid);
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
      recordFixtureEvent('partial-startup-physically-joined', {
        childJoined: true,
        childPid,
        mode,
        ownerPid,
        ownerStart,
        rootReusedAfterJoin: true,
      });
    } finally {
      controller.abort(new Error('Fixture teardown'));
      await starting?.catch(() => undefined);
      try {
        if (childPid) {
          await observer.joined;
        }
      } finally {
        await observer.close();
      }
      await removeFixtureRoot(root);
    }
  }
);
