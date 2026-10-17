'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const job = require('..');
const { commandFixture, waitForChildExit } = require('./command-job-fixture.cjs');
const windows = { skip: process.platform !== 'win32' };
const addon = JSON.stringify(path.resolve(__dirname, '..'));
const member = `const job=require(${addon}); process.send(job.getCurrentProcessIdentity()); process.disconnect(); setInterval(()=>{},1000);`;
const wrapperPrefix = `const job=require(${addon}); const {spawn}=require('node:child_process'); process.send({event:'READY',identity:job.getCurrentProcessIdentity()});`;
// The setup wrapper shares the guard's hidden console. With windowsHide and no
// inherited stdio it would get CREATE_NO_WINDOW and its own conhost.exe, which
// joins the outer Job before assignment and outlives a killed wrapper briefly,
// so the outer count after a join would race that conhost's exit.
const setup = (wrapper) => `
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
job.initialize();
const control=spawn(process.execPath,['-e',${JSON.stringify(`const job=require(${addon}); process.send(job.getCurrentProcessIdentity()); process.on('message',()=>process.send(job.getCurrentProcessIdentity()));`)}],{stdio:['ignore','ignore','ignore','ipc']});
const controlIdentity=await new Promise(resolve=>control.once('message',resolve));
const wrapper=spawn(process.execPath,['-e',${JSON.stringify(wrapperPrefix + wrapper)}],{stdio:['ignore','pipe','pipe','ipc']});
const exited=new Promise(resolve=>wrapper.once('exit',(code,signal)=>resolve({code,signal})));
const ready=await new Promise(resolve=>wrapper.once('message',resolve));
assert.equal(ready.event,'READY');
assert.equal(ready.identity.pid,wrapper.pid);
const countBeforeAssignment=job.activeProcessCount();
let commandJob=job.createCommandJob();
commandJob.assign(ready.identity);
wrapper.on('message',message=>process.send(message));
process.send({event:'ready',parent:job.getCurrentProcessIdentity(),wrapper:ready.identity,control:controlIdentity,countBeforeAssignment,count:job.activeProcessCount()});
`;

const joinCommands = `
process.on('message',async(message)=>{
 if(message.type==='START') wrapper.send(message);
 if(message.type==='join') {
  try {
   const first=commandJob.terminateAndWait(message.exitCode);
   assert.equal(commandJob.terminateAndWait(message.exitCode),first);
   const value=await first;
   const tuple=await exited;
   commandJob.close(); commandJob.close();
   const alive=await new Promise(resolve=>{control.once('message',resolve);control.send('ping');});
   process.send({event:'joined',count:job.activeProcessCount(),tuple,valueIsUndefined:value===undefined,parent:job.getCurrentProcessIdentity(),control:alive});
  } catch(error) {process.send({event:'failed',message:error.stack});}
 }
});
`;

async function check(observer) {
  observer.child.stdin.write('check\n');
  return observer.wait('check');
}

function compareIdentities(pinned, identities) {
  assert.deepEqual(
    pinned.identities.map(({ pid, start }) => ({ creationTime: start, pid })),
    identities
  );
}

test(
  'private Job validates calls and returns a lossless native self identity',
  windows,
  async (t) => {
    const fixture = await commandFixture(t);
    const guard = fixture.guard(`
const assert=require('node:assert/strict');
const identity=job.getCurrentProcessIdentity();
assert.equal(identity.pid,process.pid);
assert.equal(typeof identity.creationTime,'string');
assert.ok(BigInt(identity.creationTime)>BigInt(Number.MAX_SAFE_INTEGER));
const empty=job.createCommandJob();
assert.throws(()=>empty.assign(identity),/cannot contain its parent/);
for(const value of [null,{}, {pid:'1',creationTime:'1'}, {pid:1,creationTime:1}]) assert.throws(()=>empty.assign(value),TypeError);
for(const pid of [-1,0,0.5,NaN,Infinity,4294967296]) assert.throws(()=>empty.assign({pid,creationTime:'1'}),RangeError);
for(const args of [[],['1'],[null],[1,2]]) await assert.rejects(empty.terminateAndWait(...args),TypeError);
for(const value of [-1,0.5,NaN,Infinity,4294967296]) await assert.rejects(empty.terminateAndWait(value),RangeError);
empty.close(); empty.close();
assert.throws(()=>empty.assign(identity),/admissions are closed/);
await assert.rejects(empty.terminateAndWait(0),/is closed/);
const joined=job.createCommandJob();
const pending=joined.terminateAndWait(4294967295);
assert.equal(joined.terminateAndWait(259),pending);
assert.throws(()=>joined.close(),/has not proved cleanup/);
assert.equal(await pending,undefined);
joined.close();
assert.equal(joined.terminateAndWait(0),pending);
process.send({event:'verified',identity});
`);
    const verified = await guard.wait('verified');
    const observer = await fixture.observe([guard.child.pid]);
    compareIdentities(observer.pinned, [verified.identity]);
    assert.deepEqual((await check(observer)).waits, [258]);
  }
);

test('private READY identity mismatch does not assign or start user work', windows, async (t) => {
  const fixture = await commandFixture(t);
  const started = path.join(fixture.root, 'user-started');
  const wrapper = `process.once('message',()=>{require('node:fs').writeFileSync(${JSON.stringify(started)},'started');process.exit(0);});`;
  const guard = fixture.guard(`
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const wrapper=spawn(process.execPath,['-e',${JSON.stringify(wrapperPrefix + wrapper)}],{stdio:['ignore','ignore','ignore','ipc']});
const ready=await new Promise(resolve=>wrapper.once('message',resolve));
const commandJob=job.createCommandJob();
assert.throws(()=>commandJob.assign({...ready.identity,creationTime:(BigInt(ready.identity.creationTime)+1n).toString()}),/identity does not match/);
commandJob.close();
assert.equal(require('node:fs').existsSync(${JSON.stringify(started)}),false);
process.send({event:'verified',identity:ready.identity});
process.once('message',async(message)=>{if(message.type!=='finish')return;const exited=new Promise(resolve=>wrapper.once('exit',resolve));wrapper.send({type:'START'});await exited;process.send({event:'finished'});});
`);
  const verified = await guard.wait('verified');
  const observer = await fixture.observe([verified.identity.pid]);
  compareIdentities(observer.pinned, [verified.identity]);
  await assert.rejects(readFile(started), { code: 'ENOENT' });
  assert.deepEqual((await check(observer)).waits, [258]);
  guard.child.send({ type: 'finish' });
  await guard.wait('finished');
  assert.equal(await readFile(started, 'utf8'), 'started');
  assert.deepEqual((await check(observer)).waits, [0]);
});

test(
  'private Job physically joins an orphan after wrapper exit and preserves the same outer Job peer',
  windows,
  async (t) => {
    const fixture = await commandFixture(t);
    const wrapper = `process.once('message',()=>{const child=spawn(process.execPath,['-e',${JSON.stringify(member)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});child.once('message',identity=>{process.send({event:'member',identity},()=>process.exit(23));});child.unref();});`;
    const guard = fixture.guard(
      setup(wrapper) +
        joinCommands +
        `
exited.then(tuple=>process.send({event:'wrapper-exited',tuple}));
`
    );
    const ready = await guard.wait('ready');
    t.diagnostic(
      JSON.stringify({
        afterAssignment: ready.count,
        beforeAssignment: ready.countBeforeAssignment,
        event: 'outer-accounting',
      })
    );
    const outside = await fixture.observe([ready.parent.pid, ready.control.pid, ready.wrapper.pid]);
    compareIdentities(outside.pinned, [ready.parent, ready.control, ready.wrapper]);
    guard.child.send({ type: 'START' });
    const child = await guard.wait('member');
    assert.deepEqual((await guard.wait('wrapper-exited')).tuple, { code: 23, signal: null });
    const descendant = await fixture.observe([child.identity.pid]);
    compareIdentities(descendant.pinned, [child.identity]);
    assert.deepEqual((await check(descendant)).waits, [258]);
    guard.child.send({ exitCode: 91, type: 'join' });
    const joined = await guard.wait('joined');
    assert.equal(joined.count, 2);
    assert.equal(joined.valueIsUndefined, true);
    assert.deepEqual(joined.tuple, { code: 23, signal: null });
    assert.deepEqual(joined.parent, ready.parent);
    assert.deepEqual(joined.control, ready.control);
    assert.deepEqual((await check(outside)).waits, [258, 258, 0]);
    const retired = await check(descendant);
    assert.deepEqual(retired.waits, [0]);
    assert.deepEqual(retired.codes, [91]);
  }
);

test(
  'private Job joins attached cmd pipes and retains actual normal completion status',
  windows,
  async (t) => {
    const fixture = await commandFixture(t);
    await writeFile(
      path.join(fixture.root, 'producer.cjs'),
      `process.stdout.write('attached-output'); process.stderr.write('attached-error'); process.exit(7);`
    );
    const wrapper = `process.once('message',()=>{const child=spawn('cmd',['/c','node producer.cjs'],{cwd:process.cwd(),detached:false,stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('close',(code,signal)=>process.send({event:'COMPLETED',tuple:{code,signal},stdout,stderr},()=>process.exit(code)));});`;
    const guard = fixture.guard(setup(wrapper) + joinCommands);
    const ready = await guard.wait('ready');
    const observer = await fixture.observe([ready.wrapper.pid]);
    guard.child.send({ type: 'START' });
    const completed = await guard.wait('COMPLETED');
    assert.deepEqual(completed.tuple, { code: 7, signal: null });
    assert.equal(completed.stdout, 'attached-output');
    assert.equal(completed.stderr, 'attached-error');
    guard.child.send({ exitCode: 91, type: 'join' });
    const joined = await guard.wait('joined');
    assert.equal(joined.tuple.signal, null);
    assert.ok(joined.tuple.code === 7 || joined.tuple.code === 91);
    t.diagnostic(
      JSON.stringify({
        command: completed.tuple,
        event: 'separate-command-and-wrapper-exits',
        wrapper: joined.tuple,
      })
    );
    assert.equal(joined.count, 2);
    const retired = await check(observer);
    assert.deepEqual(retired.waits, [0]);
    assert.deepEqual(retired.codes, [joined.tuple.code]);
  }
);

test(
  'private Job physically joins a descendant born after retirement was requested',
  windows,
  async (t) => {
    const fixture = await commandFixture(t);
    const privatePipe = String.raw`\\.\pipe\brainstrike-native-retirement-${randomUUID()}`;
    const sockets = new Set();
    let released = false;
    let serverClosed;
    let pipeError;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', (error) => {
        pipeError = error;
      });
      socket.once('close', () => sockets.delete(socket));
      if (released) {
        socket.end(Buffer.from([1]));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(privatePipe, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (error) => {
      pipeError = error;
    });
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      for (const socket of sockets) {
        socket.end(Buffer.from([1]));
      }
      serverClosed = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    };
    // Release first without awaiting server close: a failed guard may still own
    // its pipe fd until normal quit. Await physical close after guard teardown.
    fixture.beforeGuards(release);
    fixture.afterGuards(async () => {
      await serverClosed;
      if (pipeError) {
        throw pipeError;
      }
    });
    const wrapper = `process.once('message',message=>{if(message.type!=='CREATE_AFTER_JOIN_REQUEST')throw new Error('Unexpected private fixture marker');const child=spawn(process.execPath,['-e',${JSON.stringify(member)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',identity=>process.send({event:'post-request-member',identity}));});`;
    const guard = fixture.guard(
      setup(wrapper) +
        `
const fs=require('node:fs');
process.on('message',async(message)=>{
 if(message.type!=='join-with-gate')return;
 try{
  const gateFd=fs.openSync(${JSON.stringify(privatePipe)},'r+');
  const byte=Buffer.alloc(1);
  fs.read(gateFd,byte,0,1,null,(error,count)=>{
   try{fs.closeSync(gateFd);}catch(closeError){process.send({event:'failed',message:closeError.stack});}
   if(error||count!==1||byte[0]!==1)process.send({event:'failed',message:error?.stack||'Private gate did not deliver its release byte'});
  });
  const pending=commandJob.terminateAndWait(259);
  assert.equal(commandJob.terminateAndWait(259),pending);
  assert.throws(()=>commandJob.close(),/cleanup remains unproved/);
  process.send({event:'join-requested',wrapper:ready.identity,isPromise:pending instanceof Promise});
  wrapper.send({type:'CREATE_AFTER_JOIN_REQUEST'});
  await pending;
  const tuple=await exited;
  commandJob.close();
  const alive=await new Promise(resolve=>{control.once('message',resolve);control.send('ping');});
  process.send({event:'joined',tuple,parent:job.getCurrentProcessIdentity(),control:alive,count:job.activeProcessCount()});
 }catch(error){process.send({event:'failed',message:error.stack});}
});
`,
      { UV_THREADPOOL_SIZE: '1' }
    );
    const ready = await guard.wait('ready');
    const outside = await fixture.observe([ready.parent.pid, ready.control.pid, ready.wrapper.pid]);
    compareIdentities(outside.pinned, [ready.parent, ready.control, ready.wrapper]);
    guard.child.send({ type: 'join-with-gate' });
    const requested = await guard.wait('join-requested');
    assert.equal(requested.isPromise, true);
    assert.deepEqual(requested.wrapper, ready.wrapper);
    const child = await guard.wait('post-request-member');
    const descendant = await fixture.observe([child.identity.pid]);
    compareIdentities(descendant.pinned, [child.identity]);
    assert.deepEqual((await check(descendant)).waits, [258]);
    assert.deepEqual((await check(outside)).waits, [258, 258, 258]);
    release();
    const joined = await guard.wait('joined');
    assert.deepEqual(joined.parent, ready.parent);
    assert.deepEqual(joined.control, ready.control);
    assert.deepEqual((await check(outside)).waits, [258, 258, 0]);
    const retired = await check(descendant);
    assert.deepEqual(retired.waits, [0]);
    assert.deepEqual(retired.codes, [259]);
    assert.deepEqual(joined.tuple, { code: 259, signal: null });
    if (pipeError) {
      throw pipeError;
    }
    t.diagnostic(
      JSON.stringify({
        child: child.identity,
        event: 'post-request-birth-physically-joined',
        outerAccounting: joined.count,
        requested,
        retired: { codes: retired.codes, waits: retired.waits },
      })
    );
  }
);

test(
  'denied private cleanup retains the same rejected Job receipt and survives GC without killing members',
  windows,
  async (t) => {
    const fixture = await commandFixture(t);
    const wrapper = `process.once('message',()=>{const child=spawn(process.execPath,['-e',${JSON.stringify(member)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',identity=>process.send({event:'member',identity}));});`;
    const guard = fixture.guard(
      setup(wrapper) +
        `
process.on('message',async(message)=>{
 if(message.type==='START')wrapper.send(message);
 if(message.type==='deny-join'){
  const pending=commandJob.terminateAndWait(91);
  let failure;try{await pending;}catch(error){failure=error;}
  assert.ok(failure);assert.match(failure.message,/OpenProcess failed with Windows error 5/);
  assert.throws(()=>commandJob.close(),/cleanup remains unproved/);
  const weak=new WeakRef(commandJob);commandJob=null;
  await new Promise(resolve=>setImmediate(resolve));global.gc();
  await new Promise(resolve=>setImmediate(resolve));global.gc();
  const retained=weak.deref();assert.ok(retained);
  assert.equal(retained.terminateAndWait(91),pending);
  let again;try{await retained.terminateAndWait(91);}catch(error){again=error;}
  assert.equal(again,failure);
  assert.throws(()=>retained.assign(ready.identity),/admissions are closed/);
  assert.throws(()=>retained.close(),/cleanup remains unproved/);
  process.send({event:'retained',message:failure.message,count:job.activeProcessCount(),parent:job.getCurrentProcessIdentity()});
 }
});
`
    );
    const ready = await guard.wait('ready');
    const outside = await fixture.observe([ready.parent.pid, ready.control.pid, ready.wrapper.pid]);
    compareIdentities(outside.pinned, [ready.parent, ready.control, ready.wrapper]);
    guard.child.send({ type: 'START' });
    const child = await guard.wait('member');
    const observer = await fixture.observe([child.identity.pid]);
    // Deny PROCESS_TERMINATE on the member and remove SeDebugPrivilege from the
    // joining guard, so the denial holds for an elevated runner too.
    observer.child.stdin.write('deny 0x1\n');
    await observer.wait('denied');
    observer.child.stdin.write(`restrict ${guard.child.pid}\n`);
    t.diagnostic(JSON.stringify(await observer.wait('restricted')));
    guard.child.send({ type: 'deny-join' });
    const retained = await guard.wait('retained');
    t.diagnostic(
      JSON.stringify({
        afterAssignment: ready.count,
        afterDeniedJoin: retained.count,
        beforeAssignment: ready.countBeforeAssignment,
        event: 'retained-outer-accounting',
      })
    );
    assert.deepEqual((await check(outside)).waits, [258, 258, 258]);
    assert.deepEqual(retained.parent, ready.parent);
    assert.match(retained.message, /Windows error 5/);
    assert.deepEqual((await check(observer)).waits, [258]);
  }
);

test('private Job containment survives the owning parent exiting abruptly', windows, async (t) => {
  const fixture = await commandFixture(t);
  const wrapper = `process.once('message',()=>{const child=spawn(process.execPath,['-e',${JSON.stringify(member)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});child.once('message',identity=>process.send({event:'member',identity}));});`;
  const guard = fixture.guard(
    setup(wrapper) +
      `process.on('message',message=>{if(message.type==='START')wrapper.send(message);});`
  );
  const ready = await guard.wait('ready');
  const owned = await fixture.observe([ready.parent.pid, ready.wrapper.pid]);
  guard.child.send({ type: 'START' });
  const child = await guard.wait('member');
  const descendant = await fixture.observe([child.identity.pid]);
  compareIdentities(descendant.pinned, [child.identity]);
  // Only this owned disposable native launcher is intentionally killed. The
  // pre-held handles prove its identity and both contained physical exits.
  guard.child.kill('SIGKILL');
  await waitForChildExit(guard.child);
  owned.child.stdin.write('join\n');
  assert.deepEqual((await owned.wait('join')).waits, [0, 0]);
  descendant.child.stdin.write('join\n');
  assert.deepEqual((await descendant.wait('join')).waits, [0]);
});

test('private Job primitives explicitly refuse unsupported platforms', {
  skip: process.platform === 'win32',
}, () => {
  assert.throws(() => job.createCommandJob(), /only available on Windows/);
  assert.throws(() => job.getCurrentProcessIdentity(), /only available on Windows/);
});
