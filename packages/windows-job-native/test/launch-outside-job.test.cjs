'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { test } = require('node:test');
const { getProcessCreationTime, waitForProcessExit } = require('..');
// A failure here is a process that never exits or never reports; the bound names the test.
const windows = { skip: process.platform !== 'win32', timeout: 60_000 };
const addon = JSON.stringify(path.resolve(__dirname, '..'));
// Each argument needs its own quoting on a Windows command line.
const ARGUMENTS = [
  '',
  'two words',
  'a"quote',
  'trailing\\',
  'slashes\\\\"then quote',
  '\\\\server\\share\\',
  'tab\there',
  'ünïcödé ✓',
];

// Connects back to the test, says who it is and what argv it got, and answers each ping.
const member = (role) => `
const job=require(${addon});
const socket=require('node:net').connect(Number(process.argv[1]),'127.0.0.1');
socket.write(JSON.stringify({role:${JSON.stringify(role)},identity:job.getCurrentProcessIdentity(),argv:process.argv.slice(2)})+'\\n');
socket.on('data',()=>socket.write('pong\\n'));
`;

/** The first IPC message from `child`, or its exit with its stderr. */
function reply(child) {
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  return new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code, signal) =>
      reject(new Error(`exited ${code ?? signal} before replying: ${stderr}`))
    );
  });
}

async function endProcess(identity) {
  if (getProcessCreationTime(identity.pid) === identity.creationTime) {
    process.kill(identity.pid);
  }
  await waitForProcessExit(identity.pid, identity.creationTime);
}

test(
  'a process launched outside the Job outlives the kill-on-close parent; a plain child does not',
  windows,
  async () => {
    const members = new Map();
    const arrived = Promise.withResolvers();
    const server = createServer((socket) => {
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      void lines.next().then(({ value }) => {
        const report = JSON.parse(value);
        members.set(report.role, { ...report, lines, socket });
        if (members.size === 2) {
          arrived.resolve();
        }
      }, arrived.reject);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = String(server.address().port);
    // The parent sits in its own kill-on-close Job, as Main does.
    const parentSource = `
const job=require(${addon});
const {spawn}=require('node:child_process');
job.initialize();
spawn(process.execPath,['-e',${JSON.stringify(member('control'))},process.argv[1]],{stdio:'ignore'});
const pid=job.launchOutsideJob(process.execPath,['-e',${JSON.stringify(member('outside'))},process.argv[1],...${JSON.stringify(ARGUMENTS)}]);
process.send({pid});
process.on('message',()=>process.exit(0));
`;
    const parent = spawn(process.execPath, ['-e', parentSource, port], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const parentExit = once(parent, 'exit');
    try {
      const { pid } = await reply(parent);
      await arrived.promise;
      const control = members.get('control');
      const outside = members.get('outside');
      assert.equal(outside.identity.pid, pid);
      assert.deepEqual(outside.argv, ARGUMENTS);

      parent.send('exit');
      assert.deepEqual(await parentExit, [0, null]);
      // Closing the parent's Job ended the child it spawned.
      await waitForProcessExit(control.identity.pid, control.identity.creationTime);
      assert.notEqual(getProcessCreationTime(control.identity.pid), control.identity.creationTime);
      // The launched process is the same live process, and still answers.
      assert.equal(getProcessCreationTime(outside.identity.pid), outside.identity.creationTime);
      outside.socket.write('ping\n');
      assert.deepEqual(await outside.lines.next(), { done: false, value: 'pong' });
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill();
      }
      await parentExit;
      for (const { identity, socket } of members.values()) {
        await endProcess(identity);
        socket.destroy();
      }
      server.close();
    }
  }
);

test(
  'a Job that forbids breakaway refuses the launch with its Windows error',
  windows,
  async () => {
    const wrapperSource = `
const job=require(${addon});
process.send(job.getCurrentProcessIdentity());
process.once('message',()=>{
 try{process.send({pid:job.launchOutsideJob(process.execPath,['-e',''])});}
 catch(error){process.send({message:error.message});}
});
`;
    // The guard's own Job allows breakaway; the private command Job it puts the wrapper in does not.
    const guardSource = `
const job=require(${addon});
const {spawn}=require('node:child_process');
(async()=>{
 job.initialize();
 const wrapper=spawn(process.execPath,['-e',${JSON.stringify(wrapperSource)}],{stdio:['ignore','ignore','ignore','ipc']});
 const identity=await new Promise(resolve=>wrapper.once('message',resolve));
 const commandJob=job.createCommandJob();
 commandJob.assign(identity);
 const outcome=new Promise(resolve=>wrapper.once('message',resolve));
 wrapper.send('launch');
 const result=await outcome;
 await commandJob.terminateAndWait(0);
 commandJob.close();
 process.send(result,()=>process.exit(0));
})().catch(error=>{process.stderr.write(error.stack);process.exit(1);});
`;
    const guard = spawn(process.execPath, ['-e', guardSource], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const guardExit = once(guard, 'exit');
    try {
      assert.deepEqual(await reply(guard), {
        message: 'CreateProcessW failed with Windows error 5.',
      });
      assert.deepEqual(await guardExit, [0, null]);
    } finally {
      if (guard.exitCode === null && guard.signalCode === null) {
        guard.kill();
      }
      await guardExit;
    }
  }
);
