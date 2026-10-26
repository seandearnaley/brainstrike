'use strict';

// Desktop Main holds one private kill-on-close Job per agent host it forks and stays outside
// it (apps/desktop/src/host-process-job.ts). The host makes its own kill-on-close Job with
// initialize(), either before or after Main's assignment. Whichever came first, a Main that
// dies must take the host and everything the host started with it.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const job = require('..');
const { commandFixture, eventDeadlineMs, waitForChildExit } = require('./command-job-fixture.cjs');

const windows = { skip: process.platform !== 'win32' };
const addon = JSON.stringify(path.resolve(__dirname, '..'));
const descendant = `const job=require(${addon}); process.send(job.getCurrentProcessIdentity()); setInterval(()=>{},1000);`;
const message = 'const message=(source)=>new Promise(resolve=>source.once("message",resolve));';

/** The host: makes its own Job and starts a child before or after Main's assignment. */
const host = (order) => `
const job=require(${addon});
const {spawn}=require('node:child_process');
${message}
const startChild=async()=>{
 job.initialize();
 const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
 return await message(child);
};
(async()=>{
 const identity=job.getCurrentProcessIdentity();
 const early=${JSON.stringify(order)}==='after'?await startChild():undefined;
 process.send({host:identity,child:early});
 await message(process);
 process.send({child:early??await startChild()});
})();
setInterval(()=>{},1000);
`;

/** Main: forks the host and assigns it to a Job of its own, unless `assign` is false. */
const main = (order, assign) => `
const {spawn}=require('node:child_process');
${message}
const host=spawn(process.execPath,['-e',${JSON.stringify(host(order))}],{stdio:['ignore','ignore','pipe','ipc']});
let stderr='';
host.stderr.on('data',data=>{stderr+=data;});
host.once('exit',code=>process.send({event:'failed',message:'Host exited ('+code+'): '+stderr}));
const first=await message(host);
if(${assign}) job.createCommandJob().assign(first.host);
host.send('assigned');
const {child}=await message(host);
process.send({event:'ready',host:first.host,child});
`;

function exited(identity) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`pid ${identity.pid} outlived Main by ${eventDeadlineMs} ms`)),
      eventDeadlineMs
    );
  });
  return Promise.race([
    job.waitForProcessExit(identity.pid, identity.creationTime),
    deadline,
  ]).finally(() => clearTimeout(timer));
}

async function killMain(t, order, assign) {
  const fixture = await commandFixture(t);
  const guard = fixture.guard(main(order, assign));
  const ready = await guard.wait('ready');
  assert.notEqual(ready.host.pid, ready.child.pid);
  guard.child.kill();
  await waitForChildExit(guard.child);
  return ready;
}

for (const order of ['before', 'after']) {
  test(
    `a killed Main ends its host and the host's child, assigned ${order} the host made its own Job`,
    windows,
    async (t) => {
      const { child, host: identity } = await killMain(t, order, true);
      await Promise.all([exited(identity), exited(child)]);
    }
  );
}

test(
  "control: without Main's Job, the host and its child outlive a killed Main",
  windows,
  async (t) => {
    const { child, host: identity } = await killMain(t, 'before', false);
    try {
      assert.equal(job.getProcessCreationTime(identity.pid), identity.creationTime);
      assert.equal(job.getProcessCreationTime(child.pid), child.creationTime);
    } finally {
      // Its own Job ends the child with the host.
      if (job.getProcessCreationTime(identity.pid) === identity.creationTime) {
        process.kill(identity.pid);
      }
      await Promise.all([exited(identity), exited(child)]);
    }
  }
);
