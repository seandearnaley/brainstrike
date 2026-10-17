'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { test } = require('node:test');
const { getCurrentProcessIdentity, getProcessCreationTime } = require('..');
const { commandFixture } = require('./command-job-fixture.cjs');
const windows = { skip: process.platform !== 'win32' };

test(
  'creation FILETIME matches the existing OS formatter and excludes an exited pinned process',
  windows,
  async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.send("ready"); process.on("message",()=>process.exit(0));'],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      }
    );
    const exited = once(child, 'exit');
    let holder;
    let holderExited;
    let lines;
    try {
      await once(child, 'message');
      const creation = getProcessCreationTime(child.pid);
      assert.match(creation, /^\d+$/);
      assert.equal(getProcessCreationTime(process.pid), getCurrentProcessIdentity().creationTime);
      // Keep an OS process handle open past exit. GetProcessTimes still returns
      // creation time on that handle; it must never imply that the owner is live.
      holder = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById(${child.pid}); $handle=$p.Handle; [Console]::WriteLine('HELD '+$p.StartTime.ToFileTimeUtc()); [Console]::ReadLine() > $null; [Console]::WriteLine('AFTER '+$p.StartTime.ToFileTimeUtc()); [Console]::ReadLine() > $null; $p.Dispose();`,
        ],
        { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }
      );
      holderExited = once(holder, 'exit');
      lines = createInterface({ input: holder.stdout });
      const output = lines[Symbol.asyncIterator]();
      assert.equal((await output.next()).value, `HELD ${creation}`);
      child.send('exit');
      await exited;
      assert.equal(getProcessCreationTime(child.pid), null);
      holder.stdin.write('observe\n');
      assert.equal((await output.next()).value, `AFTER ${creation}`);
      holder.stdin.end('release\n');
      assert.deepEqual(await holderExited, [0, null]);
    } finally {
      lines?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await exited;
      if (holder && holder.exitCode === null && holder.signalCode === null) {
        holder.kill();
      }
      if (holderExited) {
        await holderExited;
      }
    }
  }
);

test('process identity refuses invalid PIDs and an inaccessible live owner', windows, async (t) => {
  for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 32, '1']) {
    assert.throws(() => getProcessCreationTime(pid), TypeError);
  }
  // A denial is an error, never evidence that the PID is gone. The member's
  // DACL denies the probe's PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE to
  // Everyone, and the probing actor loses SeDebugPrivilege, so the denial holds
  // for an elevated runner too. The actor's kill-on-close Job ends the member.
  const fixture = await commandFixture(t);
  const actor = fixture.guard(`
const {spawn}=require('node:child_process');
job.initialize();
const member=spawn(process.execPath,['-e','process.send("ready"); setInterval(()=>{},1000);'],{stdio:['ignore','ignore','ignore','ipc']});
await new Promise(resolve=>member.once('message',resolve));
process.on('message',(message)=>{
 if(message.type!=='probe')return;
 try{process.send({event:'probed',value:job.getProcessCreationTime(member.pid)});}
 catch(error){process.send({event:'probed',message:error.message});}
});
process.send({event:'member',pid:member.pid});
`);
  const { pid } = await actor.wait('member');
  const observer = await fixture.observe([pid]);
  observer.child.stdin.write('deny 0x101000\n');
  await observer.wait('denied');
  observer.child.stdin.write(`restrict ${actor.child.pid}\n`);
  t.diagnostic(JSON.stringify(await observer.wait('restricted')));
  actor.child.send({ type: 'probe' });
  assert.deepEqual(await actor.wait('probed'), {
    event: 'probed',
    message: 'OpenProcess failed with Windows error 5.',
  });
  observer.child.stdin.write('check\n');
  assert.deepEqual((await observer.wait('check')).waits, [258]);
});
