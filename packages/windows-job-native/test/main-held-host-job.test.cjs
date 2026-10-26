'use strict';

// Desktop Main holds one private kill-on-close Job per agent host it forks and stays outside
// it (apps/desktop/src/host-process-job.ts). The host makes its own kill-on-close Job with
// initialize(), either before or after Main's assignment. Whichever came first, a Main that
// dies must take the host and everything the host started with it.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const job = require('..');
const { commandFixture, waitForChildExit } = require('./command-job-fixture.cjs');

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
 const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
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

/**
 * Main: starts the host and assigns it to a Job of its own, unless `assign` is false. Node puts
 * every child it spawns on Windows in its own kill-on-close Job unless the child is detached,
 * and Electron's utilityProcess launches the real host in no Job, so the host here is detached.
 */
const main = (order, assign) => `
const {spawn}=require('node:child_process');
${message}
const host=spawn(process.execPath,['-e',${JSON.stringify(host(order))}],{detached:true,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
let stderr='';
host.stderr.on('data',data=>{stderr+=data;});
host.once('exit',code=>process.send({event:'failed',message:'Host exited ('+code+'): '+stderr}));
const first=await message(host);
if(${assign}) job.createCommandJob().assign(first.host);
host.send('assigned');
const {child}=await message(host);
process.send({event:'ready',host:first.host,child});
`;

/** Joins the exit on the process handle; a process that outlives Main fails at the test's timeout. */
function exited(identity) {
  return job.waitForProcessExit(identity.pid, identity.creationTime);
}

async function killMain(t, order, assign) {
  const fixture = await commandFixture(t);
  const guard = fixture.guard(main(order, assign));
  const ready = await guard.wait('ready');
  // A detached host is in no Job of the test's: end whatever a failed test leaves running.
  t.after(() => {
    for (const { creationTime, pid } of [ready.host, ready.child]) {
      try {
        if (job.getProcessCreationTime(pid) === creationTime) {
          process.kill(pid);
        }
      } catch (error) {
        // Already ending: the host's own Job may end the child between the check and the kill.
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    }
  });
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
    const alive = [identity, child].map(
      ({ creationTime, pid }) => job.getProcessCreationTime(pid) === creationTime
    );
    if (alive[0]) {
      // Its own Job ends the child with the host.
      process.kill(identity.pid);
      await Promise.all([exited(identity), exited(child)]);
    }
    assert.deepEqual(alive, [true, true], 'host and child alive after Main was killed');
  }
);
